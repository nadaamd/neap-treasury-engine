// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IFxVenue} from "../interfaces/IFxVenue.sol";

/**
 * @title PausedFxVenue
 * @notice An execution venue that refuses everything, explicitly.
 *
 * @dev Intended for mainnet deployment for as long as no real venue is reachable.
 *      StableFX is an API integration restricted to verified institutions and its adapter
 *      lives off-chain (D21): the vault therefore has no credible counterparty on mainnet
 *      at deployment time.
 *
 *      There were two options. Deploy the test mock — a venue unable to source any
 *      liquidity, which would look like a trap if anyone funded it. Or deploy an explicit
 *      refusal. The second tells the truth: the system is in place, verifiable, and
 *      provably inoperative until an administrator wires a real venue in through
 *      `setVenue`.
 *
 *      A contract that refuses plainly beats a contract that pretends.
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
