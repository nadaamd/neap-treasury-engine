// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {IAttestationVerifier} from "./interfaces/IAttestationVerifier.sol";

/**
 * @title ReportVerifier
 * @notice Decides whether a report produced by the confidential engine is admissible.
 *
 * @dev This contract does not judge the report's *content* — that is the vault's job,
 *      which applies its own bounds. It judges its *provenance* and its *freshness*:
 *
 *        • the report really comes from the expected signer quorum;
 *        • it really was produced by the expected enclave, and the attestation covers
 *          this precise content and no other;
 *        • it refers to the policy version and parameter set currently in force;
 *        • it has not expired, and its market inputs are not stale;
 *        • it has never been consumed.
 *
 *      Checks are ordered from cheapest to most expensive: an expired report is rejected
 *      before any gas is spent recovering signatures.
 */
contract ReportVerifier {
    /* ---------------------------------------------------------------------- */
    /*                               Structure                                */
    /* ---------------------------------------------------------------------- */

    struct RebalanceReport {
        uint64 epoch;
        uint64 nonce;
        /// @notice Beyond this, the report is no longer executable.
        uint64 expiry;
        /// @notice Timestamp of the market data used to decide.
        uint64 inputsTimestamp;
        uint32 policyVersion;
        /// @notice Binds the report to the out-of-enclave parameter set (D5).
        bytes32 bandParamsHash;
        /// @notice Hash of the public inputs: rates, gas, indicative quotes.
        bytes32 inputsHash;
        /// @notice Commitment to the order plan, revealed later by the vault (D6).
        bytes32 ordersCommitment;
        /// @notice Aggregated metrics, in basis points — never an amount.
        int32 esBeforeBps;
        int32 esAfterBps;
        uint128 costEstimate;
        /**
         * @notice Gross notional of the plan, in the funding currency.
         *
         * @dev An acknowledged concession on confidentiality (D6). The principle is to
         *      publish only relative quantities, and this field is an amount. It is
         *      nonetheless necessary: the human approval threshold applies to the size of
         *      the plan, and the orders are sealed until execution. Without this field the
         *      treasurer would approve blind — which would not be an approval.
         *
         *      What stays protected is the *decomposition*: which currencies, in which
         *      direction, for which amounts. That is what would give away the position.
         */
        uint128 grossNotional;
    }

    /* ---------------------------------------------------------------------- */

    bytes32 private constant REPORT_TYPEHASH = keccak256(
        "RebalanceReport(uint64 epoch,uint64 nonce,uint64 expiry,uint64 inputsTimestamp,"
        "uint32 policyVersion,bytes32 bandParamsHash,bytes32 inputsHash,"
        "bytes32 ordersCommitment,int32 esBeforeBps,int32 esAfterBps,uint128 costEstimate,"
        "uint128 grossNotional)"
    );

    /// @dev Upper bound on s imposed by EIP-2: without it, every signature admits a
    ///      second valid form, which would give two identifiers for one report.
    uint256 private constant HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    TreasuryPolicy public immutable POLICY;

    IAttestationVerifier public attestationVerifier;
    /// @notice Measurement of the enclave authorised to produce reports.
    bytes32 public expectedMeasurement;

    /// @notice Authorised oracle network signers.
    mapping(address signer => bool) public isSigner;
    uint8 public signerCount;
    /// @notice Minimum number of distinct signatures.
    uint8 public threshold;

    uint64 public lastEpoch;
    uint64 public lastNonce;
    uint64 public lastVerifiedAt;

    mapping(bytes32 reportId => bool) public consumed;
    mapping(bytes32 reportId => RebalanceReport) private _reports;

    /// @dev Cached but recomputed in case of a chain fork.
    uint256 private immutable INITIAL_CHAIN_ID;
    bytes32 private immutable INITIAL_DOMAIN_SEPARATOR;

    /* ---------------------------------------------------------------------- */

    event SignerSet(address indexed signer, bool enabled);
    event ThresholdSet(uint8 threshold);
    event AttestationVerifierSet(address indexed verifier, bytes32 measurement);
    event ReportVerified(bytes32 indexed reportId, uint64 indexed epoch, uint64 nonce);

    error NotAdmin(address caller);
    error SystemPaused();
    error ReportExpired(uint64 expiry, uint256 nowTs);
    error InputsStale(uint64 inputsTimestamp, uint32 maxStalenessSec);
    error InputsFromTheFuture(uint64 inputsTimestamp);
    error SequenceNotIncreasing(uint64 epoch, uint64 nonce, uint64 lastEpoch, uint64 lastNonce);
    error EpochTooSoon(uint64 elapsed, uint32 minInterval);
    error PolicyVersionMismatch(uint32 got, uint32 expected);
    error BandParamsMismatch(bytes32 got, bytes32 expected);
    error ReportAlreadyConsumed(bytes32 reportId);
    error NotEnoughSignatures(uint256 got, uint8 required);
    error SignersNotSorted();
    error UnknownSigner(address signer);
    error MalleableSignature();
    error AttestationRejected(bytes32 reportId);
    error ThresholdOutOfRange(uint8 threshold, uint8 signerCount);
    error TimestampOverflow(uint256 value);

    /* ---------------------------------------------------------------------- */

    modifier onlyAdmin() {
        _requireAdmin();
        _;
    }

    function _requireAdmin() private view {
        if (!POLICY.isAdmin(msg.sender)) revert NotAdmin(msg.sender);
    }

    constructor(TreasuryPolicy policy_, IAttestationVerifier verifier_, bytes32 measurement_) {
        POLICY = policy_;
        attestationVerifier = verifier_;
        expectedMeasurement = measurement_;
        threshold = 1;
        INITIAL_CHAIN_ID = block.chainid;
        INITIAL_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    /* ---------------------------------------------------------------------- */
    /*                             Administration                             */
    /* ---------------------------------------------------------------------- */

    function setSigner(address signer, bool enabled) external onlyAdmin {
        bool current = isSigner[signer];
        if (current != enabled) {
            isSigner[signer] = enabled;
            signerCount = enabled ? signerCount + 1 : signerCount - 1;
        }
        emit SignerSet(signer, enabled);
    }

    function setThreshold(uint8 t) external onlyAdmin {
        if (t == 0 || t > signerCount) revert ThresholdOutOfRange(t, signerCount);
        threshold = t;
        emit ThresholdSet(t);
    }

    function setAttestationVerifier(IAttestationVerifier v, bytes32 measurement)
        external
        onlyAdmin
    {
        attestationVerifier = v;
        expectedMeasurement = measurement;
        emit AttestationVerifierSet(address(v), measurement);
    }

    /* ---------------------------------------------------------------------- */
    /*                              Identifiants                              */
    /* ---------------------------------------------------------------------- */

    /**
     * @notice Idempotency key of a report.
     * @dev Replaying a report would mean a rebalance executed twice, hence a doubled
     *      position. That is the most expensive defect imaginable in this domain, and the
     *      only protection is to consume a unique identifier atomically. The order
     *      commitment is part of it: two distinct plans in the same epoch remain two
     *      distinct reports.
     */
    function reportId(RebalanceReport calldata r) public pure returns (bytes32) {
        return keccak256(abi.encode(r.policyVersion, r.epoch, r.nonce, r.ordersCommitment));
    }

    function domainSeparator() public view returns (bytes32) {
        return
            block.chainid == INITIAL_CHAIN_ID ? INITIAL_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    /// @notice EIP-712 struct hash, exposed for off-chain tooling.
    /// @dev The engine recomputes it in TypeScript; a conformance suite checks that both
    ///      implementations produce the same bytes.
    function structHash(RebalanceReport calldata r) external pure returns (bytes32) {
        return _structHash(r);
    }

    function digest(RebalanceReport calldata r) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), _structHash(r)));
    }

    function reportOf(bytes32 id) external view returns (RebalanceReport memory) {
        return _reports[id];
    }

    /* ---------------------------------------------------------------------- */
    /*                              Verification                              */
    /* ---------------------------------------------------------------------- */

    /**
     * @notice Verifies a report and consumes it.
     * @param signatures Signatures ordered by strictly increasing signer address. The
     *                   ordering is not a convenience: it makes it impossible to present
     *                   the same signature twice to reach the quorum.
     */
    function verify(
        RebalanceReport calldata r,
        bytes calldata attestation,
        bytes[] calldata signatures
    ) external returns (bytes32 id) {
        if (POLICY.paused()) revert SystemPaused();

        // — time checks, the cheapest ones —
        //
        // The linter flags the use of block.timestamp, and rightly so: a validator has a
        // margin of a few seconds, which against a sixty-second freshness window is not
        // negligible. The window is therefore not the main protection against deciding on
        // bad prices — it is its first layer. The second, and the real one, is the
        // deviation check applied by the vault at execution time: the price obtained from
        // the venue is compared against the oracle, and the order is refused beyond the
        // threshold. A report whose inputs aged a few seconds more than intended therefore
        // cannot produce an off-market execution.
        // forge-lint: disable-next-line(block-timestamp)
        if (r.expiry <= block.timestamp) revert ReportExpired(r.expiry, block.timestamp);
        // forge-lint: disable-next-line(block-timestamp)
        if (r.inputsTimestamp > block.timestamp) revert InputsFromTheFuture(r.inputsTimestamp);

        uint32 maxStaleness = POLICY.maxStalenessSec();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp - r.inputsTimestamp > maxStaleness) {
            revert InputsStale(r.inputsTimestamp, maxStaleness);
        }

        // — idempotency, before everything else: it is the most precise check and it
        //   costs a single storage read. Placing it here guarantees that a replay fails
        //   for the right reason, rather than because a sequence check happened to catch
        //   it — an exact error beats a lucky rejection —
        id = reportId(r);
        if (consumed[id]) revert ReportAlreadyConsumed(id);

        // — strictly increasing sequence on the (epoch, nonce) pair —
        //
        // The nonce is not decorative. The spec's crisis path (§2.3) requires an
        // *off-cycle* trigger: a flow shock empties a corridor between two epochs and a
        // decision is needed immediately. Requiring strict growth of the epoch alone would
        // forbid that extra report. The (epoch, nonce) pair allows several reports within
        // one epoch while forbidding any step backwards.
        bool ordered = r.epoch > lastEpoch || (r.epoch == lastEpoch && r.nonce > lastNonce);
        if (!ordered) revert SequenceNotIncreasing(r.epoch, r.nonce, lastEpoch, lastNonce);

        // — cadence: bounds the damage from a compromised operator and cuts off an
        //   attacker triggering expensive rebalances in a loop —
        uint32 minInterval = POLICY.minEpochIntervalSec();
        if (lastVerifiedAt != 0) {
            uint64 elapsed = _toUint64(block.timestamp) - lastVerifiedAt;
            if (elapsed < minInterval) revert EpochTooSoon(elapsed, minInterval);
        }

        // — consistency with the policy in force —
        uint32 version = POLICY.policyVersion();
        if (r.policyVersion != version) revert PolicyVersionMismatch(r.policyVersion, version);
        bytes32 expectedBandParams = POLICY.bandParamsHash();
        if (r.bandParamsHash != expectedBandParams) {
            revert BandParamsMismatch(r.bandParamsHash, expectedBandParams);
        }

        // — state written before any external call —
        consumed[id] = true;
        _reports[id] = r;
        lastEpoch = r.epoch;
        lastNonce = r.nonce;
        lastVerifiedAt = _toUint64(block.timestamp);

        // — provenance —
        bytes32 payload = digest(r);
        _requireQuorum(payload, signatures);
        if (!attestationVerifier.verify(attestation, expectedMeasurement, payload)) {
            revert AttestationRejected(id);
        }

        // The linter sees an event emitted after external calls. Every external call in
        // this function is declared `view`, hence compiled to STATICCALL: a re-entrant
        // callback could not modify any state. And the order matters here — the event must
        // only be emitted if the attestation was accepted.
        // forge-lint: disable-next-line(reentrancy-events)
        emit ReportVerified(id, r.epoch, r.nonce);
    }

    /* ---------------------------------------------------------------------- */

    function _requireQuorum(bytes32 payload, bytes[] calldata signatures) private view {
        uint256 n = signatures.length;
        if (n < threshold) revert NotEnoughSignatures(n, threshold);

        // The linter discourages reverting inside a loop, because one bad element makes a
        // whole batch fail. This is not a batch of independent elements but a quorum: an
        // invalid, duplicated or unknown signature invalidates the whole thing by
        // definition. Partial success would make no sense — we are not verifying
        // signatures, we are verifying *one* collective decision.
        address previous = address(0);
        for (uint256 i = 0; i < n; i++) {
            address signer = _recover(payload, signatures[i]);
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (signer <= previous) revert SignersNotSorted();
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (!isSigner[signer]) revert UnknownSigner(signer);
            previous = signer;
        }
    }

    function _recover(bytes32 payload, bytes calldata signature) private pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // These two guards are flagged as "revert in a loop" because the caller is a
        // quorum loop: same reasoning as above.
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (uint256(s) > HALF_ORDER) revert MalleableSignature();
        address signer = ecrecover(payload, v, r, s);
        // forge-lint: disable-next-line(require-revert-in-loop)
        if (signer == address(0)) revert UnknownSigner(signer);
        return signer;
    }

    function _toUint64(uint256 v) private pure returns (uint64) {
        if (v > type(uint64).max) revert TimestampOverflow(v);
        // The preceding line is the guard that makes this cast safe.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(v);
    }

    function _structHash(RebalanceReport calldata r) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                REPORT_TYPEHASH,
                r.epoch,
                r.nonce,
                r.expiry,
                r.inputsTimestamp,
                r.policyVersion,
                r.bandParamsHash,
                r.inputsHash,
                r.ordersCommitment,
                r.esBeforeBps,
                r.esAfterBps,
                r.costEstimate,
                r.grossNotional
            )
        );
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("NEAP"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }
}
