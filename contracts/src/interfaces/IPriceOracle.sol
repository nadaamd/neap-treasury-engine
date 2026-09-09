// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IPriceOracle
 * @notice Prix de référence indépendant du lieu d'exécution.
 *
 * @dev Il ne sert pas à décider — la décision est prise hors chaîne — mais à **contredire**
 *      le lieu d'exécution. Sans une source de prix distincte de celui qui exécute, rien
 *      n'empêche un carnet vide ou un lieu malveillant de servir au pire prix disponible :
 *      le coffre n'aurait aucun moyen de savoir que le prix obtenu est aberrant.
 *
 *      En production, Chainlink Data Streams.
 */
interface IPriceOracle {
    /// @return priceWad Unités de `quote` par unité de `base`, en WAD.
    /// @return updatedAt Horodatage de la dernière mise à jour.
    function price(address base, address quote)
        external
        view
        returns (uint256 priceWad, uint64 updatedAt);
}
