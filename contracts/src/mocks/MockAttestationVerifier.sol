// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";

/**
 * @notice Attestation adapter for the local runner (D9).
 * @dev The attestation here is simply `abi.encode(measurement, payloadHash)`. This is
 *      obviously not a cryptographic proof — it is an acknowledged stand-in whose only
 *      role is to guarantee that the *chaining* is correct: the report is genuinely bound
 *      to an enclave measurement and to its own content. The day CRE provides real TEE
 *      quotes, only this contract changes.
 */
contract MockAttestationVerifier is IAttestationVerifier {
    bool public shouldFail;

    function setShouldFail(bool v) external {
        shouldFail = v;
    }

    /// @inheritdoc IAttestationVerifier
    function verify(bytes calldata attestation, bytes32 expectedMeasurement, bytes32 payloadHash)
        external
        view
        returns (bool)
    {
        if (shouldFail) return false;
        if (attestation.length != 64) return false;
        (bytes32 measurement, bytes32 payload) = abi.decode(attestation, (bytes32, bytes32));
        return measurement == expectedMeasurement && payload == payloadHash;
    }
}
