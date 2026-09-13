// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IPriceOracle
 * @notice Reference price, independent of the execution venue.
 *
 * @dev It is not there to decide — the decision is made off-chain — but to **contradict**
 *      the execution venue. Without a price source distinct from the one that executes,
 *      nothing stops an empty book or a malicious venue from filling at the worst
 *      available price: the vault would have no way to know the price obtained is absurd.
 *
 *      In production, Chainlink Data Streams.
 */
interface IPriceOracle {
    /// @return priceWad Units of `quote` per unit of `base`, in WAD.
    /// @return updatedAt Timestamp of the last update.
    function price(address base, address quote)
        external
        view
        returns (uint256 priceWad, uint64 updatedAt);
}
