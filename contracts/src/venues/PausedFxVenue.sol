// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IFxVenue} from "../interfaces/IFxVenue.sol";

/**
 * @title PausedFxVenue
 * @notice Lieu d'exécution qui refuse tout, explicitement.
 *
 * @dev Destiné au déploiement mainnet tant qu'aucun lieu réel n'est accessible.
 *      StableFX est une intégration API réservée aux institutions vérifiées et son
 *      adaptateur vit hors chaîne (D21) : le coffre n'a donc pas de contrepartie
 *      crédible sur mainnet au moment du déploiement.
 *
 *      Deux options se présentaient. Déployer le mock de test — un lieu incapable de
 *      sourcer la moindre liquidité, qui prendrait l'apparence d'un piège si quelqu'un
 *      l'alimentait. Ou déployer un refus explicite. Le second dit la vérité : le
 *      système est en place, vérifiable, et prouvablement inopérant jusqu'à ce qu'un
 *      administrateur y branche un vrai lieu par `setVenue`.
 *
 *      Un contrat qui refuse franchement vaut mieux qu'un contrat qui fait semblant.
 */
contract PausedFxVenue is IFxVenue {
    error VenueNotConfigured();

    /// @inheritdoc IFxVenue
    function quote(address, address, uint256) external pure returns (uint256, uint64, bytes32) {
        revert VenueNotConfigured();
    }

    /// @inheritdoc IFxVenue
    function settlePvP(address, address, uint256, uint256, address, bytes32)
        external
        pure
        returns (uint256)
    {
        revert VenueNotConfigured();
    }
}
