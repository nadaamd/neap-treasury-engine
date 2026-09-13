// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IAttestationVerifier
 * @notice Verifies that a report was indeed produced by the expected enclave.
 *
 * @dev Decision D9. The risk engine is a pure function runnable either inside Chainlink
 *      CRE's TEE handler or inside an isolated local runner. This interface is the only
 *      piece that changes between the two — hence an adapter, not a hard-coded call.
 *
 *      `payloadHash` is not decorative: without it, a valid attestation could be replayed
 *      with an entirely different report. The attestation must prove that *this* precise
 *      content came out of the enclave, not merely that an enclave exists.
 */
interface IAttestationVerifier {
    function verify(bytes calldata attestation, bytes32 expectedMeasurement, bytes32 payloadHash)
        external
        view
        returns (bool);
}
