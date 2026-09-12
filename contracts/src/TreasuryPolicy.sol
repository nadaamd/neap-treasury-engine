// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title TreasuryPolicy
 * @notice Autorité du système NEAP : rôles, séparation des devoirs, limites, paramètres
 *         de risque, versionnement et délai d'application.
 *
 * @dev Décision D7 — l'autorité est portée par le contrat, pas par le fournisseur de
 *      portefeuille. Trois raisons :
 *
 *      1. un modèle d'autorisation qui ne vit que dans un service tiers n'est pas
 *         vérifiable par un auditeur ni par une contrepartie ;
 *      2. cela supprime la dépendance à un éventuel quorum natif côté portefeuille ;
 *      3. cela donne au contrat une responsabilité substantielle — sans quoi le projet
 *         ne serait qu'un tableau de bord avec un `emit` décoratif.
 *
 *      Le système de rôles est écrit à la main plutôt qu'hérité d'une bibliothèque :
 *      l'invariant de séparation des devoirs demande de toute façon une logique
 *      spécifique dans l'attribution, et quarante lignes entièrement lisibles valent
 *      mieux qu'une dépendance pour un contrat dont c'est la seule raison d'être.
 */
contract TreasuryPolicy {
    /* ---------------------------------------------------------------------- */
    /*                                  Rôles                                  */
    /* ---------------------------------------------------------------------- */

    /// @notice Définit les limites et les paramètres de risque. Ne peut pas exécuter.
    bytes32 public constant RISK_OFFICER = keccak256("RISK_OFFICER");
    /// @notice Approuve les plans au-delà du seuil. Ne peut pas modifier les limites.
    bytes32 public constant TREASURER = keccak256("TREASURER");
    /// @notice Soumet et exécute les plans, dans les limites.
    bytes32 public constant OPERATOR = keccak256("OPERATOR");
    /// @notice Peut suspendre le système immédiatement. L'urgence ne se planifie pas.
    bytes32 public constant GUARDIAN = keccak256("GUARDIAN");
    /// @notice Administre les rôles.
    bytes32 public constant ADMIN = keccak256("ADMIN");

    mapping(bytes32 role => mapping(address account => bool)) private _roles;

    /* ---------------------------------------------------------------------- */
    /*                                Paramètres                               */
    /* ---------------------------------------------------------------------- */

    struct CurrencyPolicy {
        uint128 lowerBand;
        uint128 target;
        uint128 upperBand;
        uint128 maxSingleOrder;
        uint128 maxPerEpoch;
        uint128 maxRolling24h;
    }

    struct RiskParams {
        uint32 kappaBps;
        uint32 hDepegBps;
        uint32 maxExecDeviationBps;
        uint32 maxStalenessSec;
        uint32 minEpochIntervalSec;
        uint128 autoApproveThreshold;
    }

    /// @notice Délai d'application des changements de paramètres.
    uint256 public immutable TIMELOCK_DELAY;

    uint32 public policyVersion;
    bool public paused;

    /// @notice Empreinte du jeu de paramètres statistiques ayant produit les bandes.
    /// @dev Décision D5 : les bandes sont calculées hors enclave parce qu'elles ne
    ///      dépendent que des paramètres, jamais de l'état. Ce hash lie un rapport
    ///      confidentiel au jeu de paramètres auditable qui l'a produit.
    bytes32 public bandParamsHash;

    RiskParams public riskParams;
    mapping(address token => CurrencyPolicy) public currencyPolicy;
    mapping(address token => bool) public supported;

    /* ---------------------------------------------------------------------- */
    /*                            File d'attente                               */
    /* ---------------------------------------------------------------------- */

    mapping(bytes32 id => uint256 eta) public pendingEta;
    mapping(bytes32 id => bytes payload) private _pendingPayload;

    /* ---------------------------------------------------------------------- */
    /*                                Événements                               */
    /* ---------------------------------------------------------------------- */

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed by);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed by);
    event ChangeQueued(bytes32 indexed id, uint256 eta);
    event ChangeCancelled(bytes32 indexed id);
    event CurrencyPolicySet(address indexed token, uint32 version);
    event RiskParamsSet(uint32 version);
    event BandParamsCommitted(bytes32 indexed paramsHash, uint32 version);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    /* ---------------------------------------------------------------------- */
    /*                                 Erreurs                                 */
    /* ---------------------------------------------------------------------- */

    error Unauthorized(bytes32 role, address account);
    error SeparationOfDutiesViolated(address account);
    error ChangeNotQueued(bytes32 id);
    error TimelockNotElapsed(bytes32 id, uint256 eta);
    error SystemPaused();
    error InvalidBands();
    error TokenNotSupported(address token);

    /* ---------------------------------------------------------------------- */

    modifier onlyRole(bytes32 role) {
        _requireRole(role);
        _;
    }

    modifier whenNotPaused() {
        _requireNotPaused();
        _;
    }

    function _requireRole(bytes32 role) private view {
        if (!_roles[role][msg.sender]) revert Unauthorized(role, msg.sender);
    }

    function _requireNotPaused() private view {
        if (paused) revert SystemPaused();
    }

    constructor(address admin, uint256 delay) {
        TIMELOCK_DELAY = delay;
        _roles[ADMIN][admin] = true;
        emit RoleGranted(ADMIN, admin, msg.sender);
    }

    /* ---------------------------------------------------------------------- */
    /*                          Gestion des rôles                              */
    /* ---------------------------------------------------------------------- */

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    /**
     * @notice Attribue un rôle.
     * @dev Invariant central du contrôle interne : **une même adresse ne peut jamais
     *      détenir à la fois RISK_OFFICER et TREASURER**. Celui qui fixe les limites ne
     *      peut pas approuver les mouvements qui s'y conforment, et réciproquement.
     *
     *      Ce n'est pas une règle d'interface : c'est un `revert`. Un contrôle interne
     *      qui n'existe que dans l'écran n'est pas un contrôle interne.
     */
    function grantRole(bytes32 role, address account) external onlyRole(ADMIN) {
        if (
            (role == RISK_OFFICER && _roles[TREASURER][account])
                || (role == TREASURER && _roles[RISK_OFFICER][account])
        ) {
            revert SeparationOfDutiesViolated(account);
        }
        _roles[role][account] = true;
        emit RoleGranted(role, account, msg.sender);
    }

    function revokeRole(bytes32 role, address account) external onlyRole(ADMIN) {
        _roles[role][account] = false;
        emit RoleRevoked(role, account, msg.sender);
    }

    /* ---------------------------------------------------------------------- */
    /*                          Suspension d'urgence                           */
    /* ---------------------------------------------------------------------- */

    /// @dev Sans délai, volontairement : un délai sur l'arrêt d'urgence le viderait de son sens.
    function pause() external onlyRole(GUARDIAN) {
        paused = true;
        emit Paused(msg.sender);
    }

    /// @dev La reprise passe par l'administrateur, pas par le gardien : arrêter est urgent,
    ///      redémarrer ne l'est jamais.
    function unpause() external onlyRole(ADMIN) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /* ---------------------------------------------------------------------- */
    /*                    Changements de paramètres différés                   */
    /* ---------------------------------------------------------------------- */

    function queueCurrencyPolicy(address token, CurrencyPolicy calldata p)
        external
        onlyRole(RISK_OFFICER)
        returns (bytes32 id)
    {
        if (!(p.lowerBand <= p.target && p.target <= p.upperBand)) revert InvalidBands();
        id = keccak256(abi.encode("currency", token, p));
        pendingEta[id] = block.timestamp + TIMELOCK_DELAY;
        _pendingPayload[id] = abi.encode(token, p);
        emit ChangeQueued(id, pendingEta[id]);
    }

    function queueRiskParams(RiskParams calldata r)
        external
        onlyRole(RISK_OFFICER)
        returns (bytes32 id)
    {
        id = keccak256(abi.encode("risk", r));
        pendingEta[id] = block.timestamp + TIMELOCK_DELAY;
        _pendingPayload[id] = abi.encode(r);
        emit ChangeQueued(id, pendingEta[id]);
    }

    function cancel(bytes32 id) external onlyRole(ADMIN) {
        delete pendingEta[id];
        delete _pendingPayload[id];
        emit ChangeCancelled(id);
    }

    /**
     * @notice Applique un changement dont le délai est écoulé.
     * @dev Volontairement ouvert à tout appelant : la décision a déjà été prise et
     *      publiée par le RISK_OFFICER, et l'exécution mécanique d'un changement mûr
     *      n'est pas un pouvoir. Restreindre cet appel n'ajouterait aucune sécurité et
     *      créerait un risque de blocage.
     */
    function executeCurrencyPolicy(bytes32 id) external whenNotPaused {
        _requireMature(id);
        (address token, CurrencyPolicy memory p) =
            abi.decode(_pendingPayload[id], (address, CurrencyPolicy));
        delete pendingEta[id];
        delete _pendingPayload[id];

        currencyPolicy[token] = p;
        supported[token] = true;
        unchecked {
            policyVersion++;
        }
        emit CurrencyPolicySet(token, policyVersion);
    }

    function executeRiskParams(bytes32 id) external whenNotPaused {
        _requireMature(id);
        RiskParams memory r = abi.decode(_pendingPayload[id], (RiskParams));
        delete pendingEta[id];
        delete _pendingPayload[id];

        riskParams = r;
        unchecked {
            policyVersion++;
        }
        emit RiskParamsSet(policyVersion);
    }

    /**
     * @notice Engage l'empreinte des paramètres statistiques ayant servi au calcul des bandes.
     * @dev Pas de délai ici : ce hash ne confère aucun pouvoir, il documente. Les bandes
     *      elles-mêmes, qui contraignent réellement, passent par `queueCurrencyPolicy`.
     */
    function commitBandParams(bytes32 paramsHash) external onlyRole(RISK_OFFICER) {
        bandParamsHash = paramsHash;
        emit BandParamsCommitted(paramsHash, policyVersion);
    }

    /* ---------------------------------------------------------------------- */

    function bandsOf(address token)
        external
        view
        returns (uint128 lower, uint128 target, uint128 upper)
    {
        if (!supported[token]) revert TokenNotSupported(token);
        CurrencyPolicy storage p = currencyPolicy[token];
        return (p.lowerBand, p.target, p.upperBand);
    }

    /* ---------------------------------------------------------------------- */
    /*                     Accesseurs unitaires de commodité                   */
    /* ---------------------------------------------------------------------- */

    /// @dev Le getter automatique d'une structure publique renvoie un n-uplet, que les
    ///      contrats appelants devraient déballer position par position — fragile dès
    ///      qu'on ajoute un champ. Ces accesseurs nommés rendent les dépendances
    ///      explicites et résistent à l'évolution de la structure.
    function maxStalenessSec() external view returns (uint32) {
        return riskParams.maxStalenessSec;
    }

    function minEpochIntervalSec() external view returns (uint32) {
        return riskParams.minEpochIntervalSec;
    }

    function autoApproveThreshold() external view returns (uint128) {
        return riskParams.autoApproveThreshold;
    }

    function maxExecDeviationBps() external view returns (uint32) {
        return riskParams.maxExecDeviationBps;
    }

    function maxSingleOrderOf(address token) external view returns (uint128) {
        return currencyPolicy[token].maxSingleOrder;
    }

    function maxPerEpochOf(address token) external view returns (uint128) {
        return currencyPolicy[token].maxPerEpoch;
    }

    function maxRolling24hOf(address token) external view returns (uint128) {
        return currencyPolicy[token].maxRolling24h;
    }

    function isAdmin(address account) external view returns (bool) {
        return _roles[ADMIN][account];
    }

    function _requireMature(bytes32 id) private view {
        uint256 eta = pendingEta[id];
        if (eta == 0) revert ChangeNotQueued(id);
        // Le linter signale block.timestamp comme manipulable par un validateur. La marge
        // exploitable se compte en secondes, pour un délai nominal de 24 heures : ce n'est
        // pas une surface d'attaque ici. Un délai qu'on pourrait raccourcir de quinze
        // secondes reste un délai.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < eta) revert TimelockNotElapsed(id, eta);
    }
}
