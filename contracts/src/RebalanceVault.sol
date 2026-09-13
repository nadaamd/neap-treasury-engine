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
 * @notice Holds the operational balances, reveals and executes a rebalancing plan.
 *
 * @dev **The contract does not run the model, it constrains the model.**
 *
 *      The vault never trusts the report. Even signed by the quorum, even attested by the
 *      expected enclave, a plan remains subject to bounds the contract applies on its own:
 *
 *        1. cap per single order;
 *        2. cap on cumulative notional over the epoch;
 *        3. rolling twenty-four-hour cap;
 *        4. maximum gap between the obtained price and the oracle.
 *
 *      These bounds are not polite redundancy. If the engine goes wrong — a volatility
 *      estimated at zero, a corrupted calibration, a badly converted parameter — it will
 *      produce a perfectly signed and perfectly absurd plan. The bounds are what turns a
 *      model failure into a bounded incident.
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
    /// @notice Funding currency: every FX leg passes through it.
    address public immutable NUMERAIRE;

    IFxVenue public venue;
    IPriceOracle public oracle;

    mapping(bytes32 reportId => Plan) public plans;
    /// @notice Notional executed per epoch, in the funding currency.
    mapping(uint64 epoch => uint256) public epochNotional;
    /// @notice Notional executed per absolute hour — the rolling window builds on it.
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
        // Checks written inline rather than delegated: the linter does not follow a
        // helper call and would flag an unguarded address write.
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
    /*                              State machine                              */
    /* ---------------------------------------------------------------------- */

    /// @notice Submits a report: the verifier judges its provenance, the vault records
    ///         the notional and decides whether human approval is required.
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
        // The event follows the call to the verifier, which is the only external call and
        // whose failure would revert the whole transaction, event included.
        // forge-lint: disable-next-line(reentrancy-events)
        emit PlanSubmitted(id, report.epoch, needsApproval);
    }

    /// @notice Approval by the treasurer, required above the threshold.
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
     * @notice Reveals the plan and executes it.
     * @param salt Randomness of the commitment. Without it, an observer could recover the
     *             plan by exhaustive search: the space of quantised amounts is small, and
     *             an unsalted hash hides nothing.
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

        // The plan is already marked settled and the state accumulated before execution:
        // this event closes a transaction where nothing further depends on an external
        // call.
        // forge-lint: disable-next-line(reentrancy-events)
        emit PlanSettled(id, notional, orders.length);
    }

    /* ---------------------------------------------------------------------- */
    /*                     Bounds independent of the report                    */
    /* ---------------------------------------------------------------------- */

    /**
     * The `calls-loop` and `require-revert-in-loop` rules are disabled on the two blocks
     * that follow, for one and the same reason: **a rebalancing plan is atomic**.
     *
     * The linter warns against a whole batch failing because of one bad element. That is
     * exactly the intended behaviour. Partially executing a plan — selling euros without
     * buying the intended pounds — would leave the treasury in a position nobody decided,
     * worse than inaction. Better to fail as a block and decide again at the next epoch:
     * the engine will recompute from the real state.
     */
    // forge-lint: disable-start(calls-loop, require-revert-in-loop)
    function _checkBounds(Order[] calldata orders, Plan storage p)
        private
        view
        returns (uint256 notional)
    {
        for (uint256 i = 0; i < orders.length; i++) {
            Order calldata o = orders[i];

            // Every leg passes through the funding currency: that is what makes the
            // notionals commensurable, and therefore the caps additive.
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

        // The revealed notional must match the one the approval decision was based on.
        // Otherwise a treasurer would approve one amount and the operator would execute
        // another.
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
     * @notice Notional executed over the last twenty-four hours.
     * @dev A genuinely rolling window, split into twenty-four hourly buckets indexed by
     *      absolute hour. A periodically reset window would have cost two storage reads
     *      instead of twenty-four, but it lets twice the limit through on either side of a
     *      boundary — one hole too many for a constraint whose whole purpose is to bound a
     *      compromised operator.
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
    /*                                Execution                                */
    /* ---------------------------------------------------------------------- */

    /**
     * Same suppressions as for `_checkBounds`, plus three more.
     *
     * `unused-return`: the venue also returns a quote expiry, which the vault has no use
     * for — the venue is the one that enforces it.
     *
     * `reentrancy-events` and `reentrancy-no-eth`: the `execute` entry point carries
     * `nonReentrant`, and all plan state is written before the first external call. The
     * venue is moreover set by the administrator, not by the report. A malicious venue
     * could call back into the vault, but it would find neither an open re-entrant
     * function nor any state still mutable.
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
     * @notice Refuses an execution whose price departs too far from the oracle.
     * @dev This is the system's most important protection. A venue whose book has emptied,
     *      or which is malicious, would fill at the worst available price with nothing to
     *      signal it: the report would be valid, the size bounds respected, and the
     *      treasury would lose the difference in silence.
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
        // Only degradation counts: doing better than the oracle is not an incident.
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
