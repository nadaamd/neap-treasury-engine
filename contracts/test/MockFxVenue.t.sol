// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockFxVenue} from "../src/mocks/MockFxVenue.sol";

contract MockFxVenueTest is Test {
    MockFxVenue internal venue;
    MockERC20 internal usdc;
    MockERC20 internal eurc;

    address internal vault = makeAddr("vault");

    uint256 internal constant WAD = 1e18;
    uint256 internal constant DEPTH = 5_000_000e6;
    /// @dev 1 USDC → 0,92 EURC.
    uint256 internal constant RATE = 0.92e18;

    function setUp() public {
        venue = new MockFxVenue();
        usdc = new MockERC20("USD Coin", "USDC");
        eurc = new MockERC20("Euro Coin", "EURC");

        venue.configure(address(usdc), address(eurc), RATE, 2, 50, DEPTH);
        eurc.mint(address(venue), 100_000_000e6);
        usdc.mint(vault, 100_000_000e6);

        vm.prank(vault);
        usdc.approve(address(venue), type(uint256).max);
    }

    function _quoted(uint256 amountIn) internal view returns (uint256 out, bytes32 id) {
        (out,, id) = venue.quote(address(usdc), address(eurc), amountIn);
    }

    function _settle(uint256 amountIn, uint256 minOut, bytes32 id, address to)
        internal
        returns (uint256)
    {
        return venue.settlePvP(address(usdc), address(eurc), amountIn, minOut, to, id);
    }

    /* ------------------------------------------------------------------ */
    /*                          Price formation                           */
    /* ------------------------------------------------------------------ */

    function test_quoteAppliesRateAndSpread() public view {
        uint256 amountIn = 1_000e6;
        (uint256 out,,) = venue.quote(address(usdc), address(eurc), amountIn);
        // The 2 bps spread applies; impact is negligible at this size.
        uint256 mid = amountIn * RATE / WAD;
        assertLt(out, mid);
        assertGt(out, mid * 9990 / 10_000);
    }

    /// @dev Impact follows √(size/depth): quadrupling the size doubles the *relative*
    ///      cost. That is the classic empirical form, and its concavity is what makes the
    ///      "rare large orders versus frequent small ones" trade-off non-trivial.
    function test_impactFollowsSquareRoot() public view {
        uint256 small = 100_000e6;
        uint256 large = 400_000e6;

        (uint256 outSmall,,) = venue.quote(address(usdc), address(eurc), small);
        (uint256 outLarge,,) = venue.quote(address(usdc), address(eurc), large);

        uint256 costSmallBps = 10_000 - (outSmall * WAD * 10_000) / (small * RATE);
        uint256 costLargeBps = 10_000 - (outLarge * WAD * 10_000) / (large * RATE);

        uint256 impactSmall = costSmallBps - 2;
        uint256 impactLarge = costLargeBps - 2;
        assertApproxEqRel(impactLarge, impactSmall * 2, 0.02e18);
    }

    /// @dev Total cost is superlinear: splitting an order in two halves costs less impact
    ///      than executing it in one block.
    function test_totalCostIsSuperlinear() public view {
        uint256 whole = 800_000e6;
        (uint256 outWhole,,) = venue.quote(address(usdc), address(eurc), whole);
        (uint256 outHalf,,) = venue.quote(address(usdc), address(eurc), whole / 2);
        assertGt(outHalf * 2, outWhole);
    }

    function test_costIsDeterministic() public view {
        (uint256 a,,) = venue.quote(address(usdc), address(eurc), 250_000e6);
        (uint256 b,,) = venue.quote(address(usdc), address(eurc), 250_000e6);
        assertEq(a, b);
    }

    function test_unknownPairReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(MockFxVenue.PairDisabled.selector, address(eurc), address(usdc))
        );
        venue.quote(address(eurc), address(usdc), 1e6);
    }

    /* ------------------------------------------------------------------ */
    /*                             Settlement                             */
    /* ------------------------------------------------------------------ */

    function test_settlementMovesBothLegs() public {
        uint256 amountIn = 500_000e6;
        (uint256 expected, bytes32 id) = _quoted(amountIn);

        uint256 usdcBefore = usdc.balanceOf(vault);
        uint256 eurcBefore = eurc.balanceOf(vault);

        vm.prank(vault);
        uint256 out = _settle(amountIn, expected, id, vault);

        assertEq(out, expected);
        assertEq(usdc.balanceOf(vault), usdcBefore - amountIn);
        assertEq(eurc.balanceOf(vault), eurcBefore + expected);
    }

    /// @dev Deviation check: settling a size different from the quoted one changes the
    ///      price, so the quote identifier no longer matches. Without this check, a book
    ///      emptied between quote and execution would fill at the worst price.
    function test_settlingADifferentSizeIsRejected() public {
        uint256 amountIn = 500_000e6;
        (, bytes32 id) = _quoted(amountIn);

        vm.prank(vault);
        vm.expectRevert();
        _settle(amountIn * 2, 0, id, vault);
    }

    function test_slippageBoundIsEnforced() public {
        uint256 amountIn = 500_000e6;
        (uint256 expected, bytes32 id) = _quoted(amountIn);

        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(MockFxVenue.SlippageExceeded.selector, expected, expected + 1)
        );
        _settle(amountIn, expected + 1, id, vault);
    }

    /// @dev Atomicity: if the incoming leg cannot be debited, nothing moves. This is the
    ///      assumption the interface imposes on every execution venue.
    function test_settlementIsAtomicWhenTheInboundLegFails() public {
        address broke = makeAddr("broke");
        uint256 amountIn = 500_000e6;
        (uint256 expected, bytes32 id) = _quoted(amountIn);

        uint256 venueEurcBefore = eurc.balanceOf(address(venue));

        vm.startPrank(broke);
        usdc.approve(address(venue), type(uint256).max);
        vm.expectRevert();
        _settle(amountIn, expected, id, broke);
        vm.stopPrank();

        assertEq(
            eurc.balanceOf(broke), 0, "outbound leg delivered although the inbound leg failed"
        );
        assertEq(eurc.balanceOf(address(venue)), venueEurcBefore);
    }

    function testFuzz_quoteNeverExceedsMidPrice(uint256 amountIn) public view {
        amountIn = bound(amountIn, 1e6, 4_000_000e6);
        (uint256 out,,) = venue.quote(address(usdc), address(eurc), amountIn);
        assertLe(out, amountIn * RATE / WAD);
    }

    /// @dev Beyond a certain size the cost would reach the notional: the venue refuses
    ///      rather than quoting an absurd price.
    function test_absurdSizeIsRejectedRatherThanPricedNonsensically() public {
        venue.configure(address(usdc), address(eurc), RATE, 2, 5000, DEPTH);
        vm.expectRevert(MockFxVenue.CostExceedsNotional.selector);
        venue.quote(address(usdc), address(eurc), 100_000_000e6);
    }
}
