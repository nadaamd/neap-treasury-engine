// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PausedFxVenue} from "../src/venues/PausedFxVenue.sol";

contract PausedFxVenueTest is Test {
    PausedFxVenue internal venue;

    function setUp() public {
        venue = new PausedFxVenue();
    }

    /// @dev The refusal must be explicit and named. A venue returning zero would let the
    ///      vault believe in a zero quote rather than in the absence of a venue.
    function test_quoteRefusesExplicitly() public {
        vm.expectRevert(PausedFxVenue.VenueNotConfigured.selector);
        venue.quote(address(1), address(2), 1e6);
    }

    function test_settlementRefusesExplicitly() public {
        vm.expectRevert(PausedFxVenue.VenueNotConfigured.selector);
        venue.settlePvP(address(1), address(2), 1e6, 0, address(3), bytes32(0));
    }

    /// @dev No state, hence nothing to compromise: that is the whole point of an inert
    ///      venue deployed on mainnet while waiting for a real one.
    function test_holdsNothing() public view {
        assertEq(address(venue).balance, 0);
    }
}
