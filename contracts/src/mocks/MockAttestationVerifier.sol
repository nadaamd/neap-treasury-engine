// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAttestationVerifier} from "../interfaces/IAttestationVerifier.sol";

/**
 * @notice Adaptateur d'attestation pour le runner local (D9).
 * @dev L'attestation est ici simplement `abi.encode(measurement, payloadHash)`. Ce n'est
 *      évidemment pas une preuve cryptographique — c'est un substitut assumé, dont le
 *      seul rôle est de garantir que le *chaînage* est correct : le rapport est bien lié
 *      à une mesure d'enclave et à son propre contenu. Le jour où CRE fournit de vraies
 *      citations TEE, seul ce contrat change.
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
