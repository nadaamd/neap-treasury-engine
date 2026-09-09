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

    function _prepare(uint256 amountIn) internal returns (uint256 out, bytes32 id) {
        (out,, id) = venue.prepare(address(usdc), address(eurc), amountIn);
    }

    /* ------------------------------------------------------------------ */
    /*                            Formation du prix                        */
    /* ------------------------------------------------------------------ */

    function test_quoteAppliesRateAndSpread() public view {
        uint256 amountIn = 1_000e6;
        (uint256 out,,) = venue.quote(address(usdc), address(eurc), amountIn);
        // Le spread de 2 bps s'applique, l'impact est négligeable à cette taille.
        uint256 mid = amountIn * RATE / WAD;
        assertLt(out, mid);
        assertGt(out, mid * 9990 / 10_000);
    }

    /// @dev L'impact suit √(taille/profondeur) : quadrupler la taille double le coût
    ///      *relatif*. C'est la forme empirique classique, et sa concavité est ce qui
    ///      rend l'arbitrage « gros ordres rares contre petits ordres fréquents »
    ///      non trivial.
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

    /// @dev Le coût total est superlinéaire : scinder un ordre en deux moitiés coûte
    ///      moins cher en impact que de l'exécuter d'un bloc.
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
    /*                              Règlement                              */
    /* ------------------------------------------------------------------ */

    function test_settlementMovesBothLegs() public {
        uint256 amountIn = 500_000e6;
        (uint256 expected, bytes32 id) = _prepare(amountIn);

        uint256 usdcBefore = usdc.balanceOf(vault);
        uint256 eurcBefore = eurc.balanceOf(vault);

        vm.prank(vault);
        uint256 out = venue.settlePvP(id, amountIn, expected, vault);

        assertEq(out, expected);
        assertEq(usdc.balanceOf(vault), usdcBefore - amountIn);
        assertEq(eurc.balanceOf(vault), eurcBefore + expected);
    }

    /// @dev Contrôle de déviation : régler une taille différente de celle annoncée
    ///      change le prix, donc l'identifiant du quote ne correspond plus. Sans ce
    ///      contrôle, un carnet vidé entre l'annonce et l'exécution servirait au pire prix.
    function test_settlingADifferentSizeIsRejected() public {
        uint256 amountIn = 500_000e6;
        (, bytes32 id) = _prepare(amountIn);

        vm.prank(vault);
        vm.expectRevert();
        venue.settlePvP(id, amountIn * 2, 0, vault);
    }

    function test_slippageBoundIsEnforced() public {
        uint256 amountIn = 500_000e6;
        (uint256 expected, bytes32 id) = _prepare(amountIn);

        vm.prank(vault);
        vm.expectRevert(
            abi.encodeWithSelector(MockFxVenue.SlippageExceeded.selector, expected, expected + 1)
        );
        venue.settlePvP(id, amountIn, expected + 1, vault);
    }

    /// @dev Atomicité : si la jambe entrante ne peut pas être débitée, rien ne bouge.
    ///      C'est l'hypothèse que l'interface impose à tout lieu d'exécution, et la
    ///      question posée à Arc au jalon 0.
    function test_settlementIsAtomicWhenTheInboundLegFails() public {
        address broke = makeAddr("broke");
        uint256 amountIn = 500_000e6;
        (uint256 expected, bytes32 id) = _prepare(amountIn);

        uint256 venueEurcBefore = eurc.balanceOf(address(venue));

        vm.startPrank(broke);
        usdc.approve(address(venue), type(uint256).max);
        vm.expectRevert();
        venue.settlePvP(id, amountIn, expected, broke);
        vm.stopPrank();

        assertEq(
            eurc.balanceOf(broke), 0, "jambe sortante livree alors que la jambe entrante a echoue"
        );
        assertEq(eurc.balanceOf(address(venue)), venueEurcBefore);
    }

    function testFuzz_quoteNeverExceedsMidPrice(uint256 amountIn) public view {
        amountIn = bound(amountIn, 1e6, 4_000_000e6);
        (uint256 out,,) = venue.quote(address(usdc), address(eurc), amountIn);
        assertLe(out, amountIn * RATE / WAD);
    }

    /// @dev Au-delà d'une certaine taille le coût atteindrait le notionnel : le lieu
    ///      refuse plutôt que de coter un prix absurde.
    function test_absurdSizeIsRejectedRatherThanPricedNonsensically() public {
        venue.configure(address(usdc), address(eurc), RATE, 2, 5000, DEPTH);
        vm.expectRevert(MockFxVenue.CostExceedsNotional.selector);
        venue.quote(address(usdc), address(eurc), 100_000_000e6);
    }
}
