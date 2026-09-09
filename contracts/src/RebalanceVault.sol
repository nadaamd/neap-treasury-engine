// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {ReportVerifier} from "./ReportVerifier.sol";
import {IFxVenue} from "./interfaces/IFxVenue.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title RebalanceVault
 * @notice Détient les soldes opérationnels, révèle et exécute un plan de rééquilibrage.
 *
 * @dev **Le contrat n'exécute pas le modèle, il contraint le modèle.**
 *
 *      Le coffre ne fait jamais confiance au rapport. Même signé par le quorum, même
 *      attesté par l'enclave attendue, un plan reste soumis à des bornes que le contrat
 *      applique seul :
 *
 *        1. plafond par ordre unitaire ;
 *        2. plafond de notionnel cumulé sur l'epoch ;
 *        3. plafond glissant sur vingt-quatre heures ;
 *        4. écart maximal entre le prix obtenu et l'oracle.
 *
 *      Ces bornes ne sont pas une redondance de politesse. Si le moteur déraille — une
 *      volatilité estimée à zéro, une calibration corrompue, un paramètre mal converti —
 *      il produira un plan parfaitement signé et parfaitement absurde. Les bornes sont
 *      ce qui transforme une panne de modèle en incident borné.
 */
contract RebalanceVault {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant WINDOW_HOURS = 24;

    struct Order {
        address sell;
        address buy;
        uint128 amountIn;
        uint128 minAmountOut;
    }

    enum Status {
        None,
        AwaitingApproval,
        Ready,
        Settled
    }

    struct Plan {
        Status status;
        uint64 epoch;
        uint128 grossNotional;
        bytes32 ordersCommitment;
    }

    TreasuryPolicy public immutable POLICY;
    ReportVerifier public immutable VERIFIER;
    /// @notice Devise de financement : toute jambe de change en passe par elle.
    address public immutable NUMERAIRE;

    IFxVenue public venue;
    IPriceOracle public oracle;

    mapping(bytes32 reportId => Plan) public plans;
    /// @notice Notionnel exécuté par epoch, dans la devise de financement.
    mapping(uint64 epoch => uint256) public epochNotional;
    /// @notice Notionnel exécuté par heure absolue — la fenêtre glissante s'appuie dessus.
    mapping(uint256 hourIndex => uint256) public hourlyNotional;

    uint256 private _locked;

    /* ---------------------------------------------------------------------- */

    event VenueSet(address indexed venue, address indexed oracle);
    event PlanSubmitted(bytes32 indexed reportId, uint64 indexed epoch, bool needsApproval);
    event PlanApproved(bytes32 indexed reportId, address indexed treasurer);
    event OrderExecuted(
        bytes32 indexed reportId,
        address indexed sell,
        address indexed buy,
        uint256 amountIn,
        uint256 amountOut
    );
    event PlanSettled(bytes32 indexed reportId, uint256 grossNotional, uint256 orders);

    error NotAdmin(address caller);
    error Unauthorized(bytes32 role, address account);
    error Reentrancy();
    error SystemPaused();
    error WrongStatus(bytes32 reportId, Status got, Status expected);
    error ApprovalNotRequired(bytes32 reportId);
    error CommitmentMismatch(bytes32 revealed, bytes32 expected);
    error NotionalMismatch(uint256 revealed, uint128 declared);
    error LegMustTouchNumeraire(address sell, address buy);
    error TokenNotSupported(address token);
    error SingleOrderTooLarge(address token, uint256 amount, uint128 limit);
    error EpochLimitExceeded(uint256 total, uint128 limit);
    error RollingLimitExceeded(uint256 total, uint128 limit);
    error PriceDeviation(uint256 executedWad, uint256 oracleWad, uint32 maxBps);
    error OracleUnavailable(address base, address quote);
    error EmptyPlan();
    error ZeroAddress();
    error ApprovalFailed(address token);

    /* ---------------------------------------------------------------------- */

    modifier nonReentrant() {
        _enter();
        _;
        _locked = 0;
    }

    function _enter() private {
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
    }

    modifier onlyRole(bytes32 role) {
        _requireRole(role);
        _;
    }

    function _requireRole(bytes32 role) private view {
        if (!POLICY.hasRole(role, msg.sender)) revert Unauthorized(role, msg.sender);
    }

    function _requireNotPaused() private view {
        if (POLICY.paused()) revert SystemPaused();
    }

    constructor(
        TreasuryPolicy policy_,
        ReportVerifier verifier_,
        address numeraire_,
        IFxVenue venue_,
        IPriceOracle oracle_
    ) {
        // Vérifications écrites en ligne plutôt que déléguées : le linter ne suit pas
        // l'appel à un assistant et signalerait une écriture d'adresse non gardée.
        if (numeraire_ == address(0)) revert ZeroAddress();
        if (address(venue_) == address(0)) revert ZeroAddress();
        if (address(oracle_) == address(0)) revert ZeroAddress();
        POLICY = policy_;
        VERIFIER = verifier_;
        NUMERAIRE = numeraire_;
        venue = venue_;
        oracle = oracle_;
    }

    function setVenue(IFxVenue v, IPriceOracle o) external {
        if (!POLICY.isAdmin(msg.sender)) revert NotAdmin(msg.sender);
        if (address(v) == address(0)) revert ZeroAddress();
        if (address(o) == address(0)) revert ZeroAddress();
        venue = v;
        oracle = o;
        emit VenueSet(address(v), address(o));
    }

    /* ---------------------------------------------------------------------- */
    /*                            Machine à états                              */
    /* ---------------------------------------------------------------------- */

    /// @notice Soumet un rapport : le vérificateur en juge la provenance, le coffre en
    ///         retient le notionnel et décide si une approbation humaine est requise.
    function submit(
        ReportVerifier.RebalanceReport calldata report,
        bytes calldata attestation,
        bytes[] calldata signatures
    ) external onlyRole(POLICY.OPERATOR()) returns (bytes32 id) {
        _requireNotPaused();
        id = VERIFIER.verify(report, attestation, signatures);

        bool needsApproval = report.grossNotional > POLICY.autoApproveThreshold();
        plans[id] = Plan({
            status: needsApproval ? Status.AwaitingApproval : Status.Ready,
            epoch: report.epoch,
            grossNotional: report.grossNotional,
            ordersCommitment: report.ordersCommitment
        });
        // L'événement suit l'appel au vérificateur, qui est le seul appel externe et
        // dont l'échec annulerait toute la transaction, événement compris.
        // forge-lint: disable-next-line(reentrancy-events)
        emit PlanSubmitted(id, report.epoch, needsApproval);
    }

    /// @notice Approbation par le trésorier, requise au-delà du seuil.
    function approve(bytes32 id) external onlyRole(POLICY.TREASURER()) {
        _requireNotPaused();
        Plan storage p = plans[id];
        if (p.status != Status.AwaitingApproval) {
            revert ApprovalNotRequired(id);
        }
        p.status = Status.Ready;
        // forge-lint: disable-next-line(reentrancy-events)
        emit PlanApproved(id, msg.sender);
    }

    /**
     * @notice Révèle le plan et l'exécute.
     * @param salt Aléa de l'engagement. Sans lui, un observateur pourrait retrouver le
     *             plan par recherche exhaustive : l'espace des montants quantifiés est
     *             petit, et un hachage sans sel ne cache rien.
     */
    function execute(bytes32 id, Order[] calldata orders, bytes32 salt)
        external
        nonReentrant
        onlyRole(POLICY.OPERATOR())
    {
        _requireNotPaused();
        Plan storage p = plans[id];
        if (p.status != Status.Ready) revert WrongStatus(id, p.status, Status.Ready);
        if (orders.length == 0) revert EmptyPlan();

        bytes32 revealed = keccak256(abi.encode(orders, salt));
        if (revealed != p.ordersCommitment) {
            revert CommitmentMismatch(revealed, p.ordersCommitment);
        }

        uint256 notional = _checkBounds(orders, p);
        p.status = Status.Settled;

        _accumulate(p.epoch, notional);
        _executeAll(id, orders);

        // Le plan est déjà marqué réglé et l'état accumulé avant l'exécution : cet
        // événement clôt une transaction dont plus rien ne dépend d'un appel externe.
        // forge-lint: disable-next-line(reentrancy-events)
        emit PlanSettled(id, notional, orders.length);
    }

    /* ---------------------------------------------------------------------- */
    /*                      Bornes indépendantes du rapport                    */
    /* ---------------------------------------------------------------------- */

    /**
     * Les règles `calls-loop` et `require-revert-in-loop` sont neutralisées sur les deux
     * blocs qui suivent, et pour une seule et même raison : **un plan de rééquilibrage
     * est atomique**.
     *
     * Le linter met en garde contre l'échec d'un lot entier à cause d'un élément fautif.
     * C'est exactement le comportement voulu. Exécuter partiellement un plan — vendre de
     * l'euro sans acheter la livre prévue — laisserait la trésorerie dans une position
     * que personne n'a décidée, pire que l'inaction. Mieux vaut échouer en bloc et
     * redécider à l'epoch suivant : le moteur recalculera à partir de l'état réel.
     */
    // forge-lint: disable-start(calls-loop, require-revert-in-loop)
    function _checkBounds(Order[] calldata orders, Plan storage p)
        private
        view
        returns (uint256 notional)
    {
        for (uint256 i = 0; i < orders.length; i++) {
            Order calldata o = orders[i];

            // Toute jambe passe par la devise de financement : c'est ce qui rend les
            // notionnels commensurables et donc les plafonds cumulables.
            bool sellsNumeraire = o.sell == NUMERAIRE;
            bool buysNumeraire = o.buy == NUMERAIRE;
            if (sellsNumeraire == buysNumeraire) revert LegMustTouchNumeraire(o.sell, o.buy);

            address subject = sellsNumeraire ? o.buy : o.sell;
            if (!POLICY.supported(subject)) revert TokenNotSupported(subject);

            uint128 maxSingleOrder = POLICY.maxSingleOrderOf(subject);
            uint256 legNotional = sellsNumeraire ? o.amountIn : o.minAmountOut;
            if (legNotional > maxSingleOrder) {
                revert SingleOrderTooLarge(subject, legNotional, maxSingleOrder);
            }
            notional += legNotional;
        }

        // Le notionnel révélé doit correspondre à celui qui a fondé la décision
        // d'approbation. Sinon, un trésorier approuverait un montant et l'opérateur en
        // exécuterait un autre.
        if (notional != p.grossNotional) revert NotionalMismatch(notional, p.grossNotional);

        address first = orders[0].sell == NUMERAIRE ? orders[0].buy : orders[0].sell;
        uint128 maxPerEpoch = POLICY.maxPerEpochOf(first);
        uint128 maxRolling24h = POLICY.maxRolling24hOf(first);

        uint256 epochTotal = epochNotional[p.epoch] + notional;
        if (epochTotal > maxPerEpoch) revert EpochLimitExceeded(epochTotal, maxPerEpoch);

        uint256 rollingTotal = _rolling24h() + notional;
        if (rollingTotal > maxRolling24h) revert RollingLimitExceeded(rollingTotal, maxRolling24h);
    }

    // forge-lint: disable-end(calls-loop, require-revert-in-loop)

    /**
     * @notice Notionnel exécuté sur les vingt-quatre dernières heures.
     * @dev Fenêtre réellement glissante, découpée en vingt-quatre seaux horaires indexés
     *      par heure absolue. Une fenêtre à remise à zéro périodique aurait coûté deux
     *      accès au stockage au lieu de vingt-quatre, mais elle laisse passer deux fois
     *      la limite de part et d'autre d'une frontière — un trou de trop pour une
     *      contrainte dont la raison d'être est de borner un opérateur compromis.
     */
    function _rolling24h() public view returns (uint256 total) {
        uint256 currentHour = block.timestamp / 1 hours;
        for (uint256 i = 0; i < WINDOW_HOURS; i++) {
            total += hourlyNotional[currentHour - i];
        }
    }

    function _accumulate(uint64 epoch, uint256 notional) private {
        epochNotional[epoch] += notional;
        hourlyNotional[block.timestamp / 1 hours] += notional;
    }

    /* ---------------------------------------------------------------------- */
    /*                                Exécution                                */
    /* ---------------------------------------------------------------------- */

    /**
     * Mêmes neutralisations que pour `_checkBounds`, plus trois autres.
     *
     * `unused-return` : le lieu d'exécution renvoie aussi une échéance de cotation, dont
     * le coffre n'a pas l'usage — c'est le lieu qui la fait respecter.
     *
     * `reentrancy-events` et `reentrancy-no-eth` : le point d'entrée `execute` porte
     * `nonReentrant`, et tout l'état du plan est écrit avant le premier appel externe.
     * Le lieu d'exécution est par ailleurs fixé par l'administrateur, pas par le rapport.
     * Un lieu malveillant pourrait rappeler le coffre, mais il ne trouverait ni fonction
     * réentrante ouverte, ni état encore modifiable.
     */
    // forge-lint: disable-start(calls-loop, require-revert-in-loop, unused-return, reentrancy-events, reentrancy-no-eth)
    function _executeAll(bytes32 id, Order[] calldata orders) private {
        uint32 maxDeviation = POLICY.maxExecDeviationBps();
        IFxVenue v = venue;

        for (uint256 i = 0; i < orders.length; i++) {
            Order calldata o = orders[i];
            (uint256 expectedOut,, bytes32 quoteId) = v.quote(o.sell, o.buy, o.amountIn);

            _requireWithinOracleBand(o.sell, o.buy, o.amountIn, expectedOut, maxDeviation);

            if (!IERC20Minimal(o.sell).approve(address(v), o.amountIn)) {
                revert ApprovalFailed(o.sell);
            }
            uint256 out =
                v.settlePvP(o.sell, o.buy, o.amountIn, o.minAmountOut, address(this), quoteId);

            emit OrderExecuted(id, o.sell, o.buy, o.amountIn, out);
        }
    }

    /**
     * @notice Refuse une exécution dont le prix s'écarte trop de l'oracle.
     * @dev C'est la protection la plus importante du système. Un lieu d'exécution dont le
     *      carnet s'est vidé, ou qui est malveillant, servirait au pire prix disponible
     *      sans que rien ne le signale : le rapport serait valide, les bornes de taille
     *      respectées, et la trésorerie perdrait la différence en silence.
     */
    function _requireWithinOracleBand(
        address sell,
        address buy,
        uint256 amountIn,
        uint256 amountOut,
        uint32 maxDeviationBps
    ) private view {
        (uint256 referenceWad, uint64 updatedAt) = oracle.price(sell, buy);
        if (referenceWad == 0 || updatedAt == 0) revert OracleUnavailable(sell, buy);

        uint256 executedWad = amountOut * WAD / amountIn;
        // Seule la dégradation compte : obtenir mieux que l'oracle n'est pas un incident.
        if (executedWad >= referenceWad) return;

        uint256 shortfallBps = (referenceWad - executedWad) * BPS / referenceWad;
        if (shortfallBps > maxDeviationBps) {
            revert PriceDeviation(executedWad, referenceWad, maxDeviationBps);
        }
    }

    // forge-lint: disable-end(calls-loop, require-revert-in-loop, unused-return, reentrancy-events, reentrancy-no-eth)

    /* ---------------------------------------------------------------------- */

    function statusOf(bytes32 id) external view returns (Status) {
        return plans[id].status;
    }

    function balance(address token) external view returns (uint256) {
        return IERC20Minimal(token).balanceOf(address(this));
    }
}
