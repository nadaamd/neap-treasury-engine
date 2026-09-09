// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IAttestationVerifier
 * @notice Vérifie qu'un rapport a bien été produit par l'enclave attendue.
 *
 * @dev Décision D9. Le moteur de risque est une fonction pure exécutable soit dans le
 *      handler TEE de Chainlink CRE, soit dans un runner local isolé. Cette interface
 *      est la seule pièce qui change entre les deux — d'où un adaptateur, et non un
 *      appel en dur.
 *
 *      `payloadHash` n'est pas décoratif : sans lui, une attestation valide pourrait
 *      être rejouée avec un tout autre rapport. L'attestation doit prouver que *ce*
 *      contenu précis est sorti de l'enclave, pas seulement qu'une enclave existe.
 */
interface IAttestationVerifier {
    function verify(bytes calldata attestation, bytes32 expectedMeasurement, bytes32 payloadHash)
        external
        view
        returns (bool);
}
