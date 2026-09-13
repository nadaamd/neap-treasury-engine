// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title TreasuryPolicy
 * @notice Authority of the NEAP system: roles, separation of duties, limits, risk
 *         parameters, versioning and timelock.
 *
 * @dev Decision D7 — authority is carried by the contract, not by the wallet provider.
 *      Three reasons:
 *
 *      1. an authorisation model that lives only in a third-party service is not
 *         verifiable by an auditor or by a counterparty;
 *      2. it removes any dependence on a native wallet-side quorum;
 *      3. it gives the contract substantial responsibility — without which the project
 *         would be a dashboard with a decorative `emit`.
 *
 *      The role system is hand-written rather than inherited from a library: the
 *      separation-of-duties invariant needs specific logic in the grant path anyway, and
 *      forty fully readable lines beat a dependency for a contract whose entire purpose
 *      this is.
 */
contract TreasuryPolicy {
    /* ---------------------------------------------------------------------- */
    /*                                  Roles                                  */
    /* ---------------------------------------------------------------------- */

    /// @notice Sets the limits and the risk parameters. Cannot execute.
    bytes32 public constant RISK_OFFICER = keccak256("RISK_OFFICER");
    /// @notice Approves plans above the threshold. Cannot change the limits.
    bytes32 public constant TREASURER = keccak256("TREASURER");
    /// @notice Submits and executes plans, within the limits.
    bytes32 public constant OPERATOR = keccak256("OPERATOR");
    /// @notice Can pause the system immediately. Emergencies cannot be scheduled.
    bytes32 public constant GUARDIAN = keccak256("GUARDIAN");
    /// @notice Administers the roles.
    bytes32 public constant ADMIN = keccak256("ADMIN");

    mapping(bytes32 role => mapping(address account => bool)) private _roles;

    /* ---------------------------------------------------------------------- */
    /*                                Parameters                               */
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

    /// @notice Timelock delay for parameter changes.
    uint256 public immutable TIMELOCK_DELAY;

    uint32 public policyVersion;
    bool public paused;

    /// @notice Hash of the statistical parameter set that produced the bands.
    /// @dev Decision D5: the bands are computed outside the enclave because they depend
    ///      only on parameters, never on state. This hash binds a confidential report to
    ///      the auditable parameter set that produced it.
    bytes32 public bandParamsHash;

    RiskParams public riskParams;
    mapping(address token => CurrencyPolicy) public currencyPolicy;
    mapping(address token => bool) public supported;

    /* ---------------------------------------------------------------------- */
    /*                              Pending queue                              */
    /* ---------------------------------------------------------------------- */

    mapping(bytes32 id => uint256 eta) public pendingEta;
    mapping(bytes32 id => bytes payload) private _pendingPayload;

    /* ---------------------------------------------------------------------- */
    /*                                  Events                                 */
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
    /*                                  Errors                                 */
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
    /*                             Role management                             */
    /* ---------------------------------------------------------------------- */

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    /**
     * @notice Grants a role.
     * @dev The central internal-control invariant: **one address can never hold both
     *      RISK_OFFICER and TREASURER**. Whoever sets the limits cannot approve the
     *      movements that comply with them, and vice versa.
     *
     *      This is not a UI rule: it is a `revert`. An internal control that exists only
     *      on the screen is not an internal control.
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
    /*                             Emergency pause                             */
    /* ---------------------------------------------------------------------- */

    /// @dev Deliberately without a timelock: a delay on an emergency stop would empty it of meaning.
    function pause() external onlyRole(GUARDIAN) {
        paused = true;
        emit Paused(msg.sender);
    }

    /// @dev Resuming goes through the administrator, not the guardian: stopping is urgent,
    ///      restarting never is.
    function unpause() external onlyRole(ADMIN) {
        paused = false;
        emit Unpaused(msg.sender);
    }

    /* ---------------------------------------------------------------------- */
    /*                        Timelocked parameter changes                     */
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
     * @notice Applies a change whose timelock has elapsed.
     * @dev Deliberately open to any caller: the decision has already been made and
     *      published by the RISK_OFFICER, and mechanically executing a matured change is
     *      not a power. Restricting this call would add no security and would create a
     *      liveness risk.
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
     * @notice Commits the hash of the statistical parameters used to compute the bands.
     * @dev No timelock here: this hash confers no power, it documents. The bands
     *      themselves, which genuinely constrain, go through `queueCurrencyPolicy`.
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
    /*                        Convenience single getters                       */
    /* ---------------------------------------------------------------------- */

    /// @dev The automatic getter of a public struct returns a tuple, which calling
    ///      contracts would have to unpack position by position — fragile as soon as a
    ///      field is added. These named getters make the dependencies explicit and survive
    ///      changes to the struct.
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
        // The linter flags block.timestamp as validator-manipulable. The exploitable
        // margin is a matter of seconds, against a nominal 24-hour delay: that is not an
        // attack surface here. A timelock you could shorten by fifteen seconds is still a
        // timelock.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < eta) revert TimelockNotElapsed(id, eta);
    }
}
