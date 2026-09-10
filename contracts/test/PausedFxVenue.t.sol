// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PausedFxVenue} from "../src/venues/PausedFxVenue.sol";

contract PausedFxVenueTest is Test {
    PausedFxVenue internal venue;

    function setUp() public {
        venue = new PausedFxVenue();
    }

    /// @dev Le refus doit être explicite et nommé. Un lieu qui renverrait zéro laisserait
    ///      le coffre croire à une cotation nulle plutôt qu'à une absence de lieu.
    function test_quoteRefusesExplicitly() public {
        vm.expectRevert(PausedFxVenue.VenueNotConfigured.selector);
        venue.quote(address(1), address(2), 1e6);
    }

    function test_settlementRefusesExplicitly() public {
        vm.expectRevert(PausedFxVenue.VenueNotConfigured.selector);
        venue.settlePvP(address(1), address(2), 1e6, 0, address(3), bytes32(0));
    }

    /// @dev Aucun état, donc rien à compromettre : c'est tout l'intérêt d'un lieu inerte
    ///      déployé sur mainnet en attendant qu'un vrai lieu soit accessible.
    function test_holdsNothing() public view {
        assertEq(address(venue).balance, 0);
    }
}
