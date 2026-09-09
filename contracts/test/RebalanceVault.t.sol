// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TreasuryPolicy} from "../src/TreasuryPolicy.sol";
import {ReportVerifier} from "../src/ReportVerifier.sol";
import {RebalanceVault} from "../src/RebalanceVault.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockFxVenue} from "../src/mocks/MockFxVenue.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {MockAttestationVerifier} from "../src/mocks/MockAttestationVerifier.sol";

contract RebalanceVaultTest is Test {
    TreasuryPolicy internal policy;
    ReportVerifier internal verifier;
    RebalanceVault internal vault;
    MockFxVenue internal venue;
    MockPriceOracle internal oracle;
    MockAttestationVerifier internal attestor;

    MockERC20 internal usdc;
    MockERC20 internal eurc;

    address internal admin = makeAddr("admin");
    address internal riskOfficer = makeAddr("riskOfficer");
    address internal treasurer = makeAddr("treasurer");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");

    address internal signerA;
    uint256 internal keyA;

    bytes32 internal constant MEASUREMENT = keccak256("enclave-v1");
    bytes32 internal constant BAND_PARAMS = keccak256("band-params-v1");
    bytes32 internal constant SALT = keccak256("sel");

    uint256 internal constant WAD = 1e18;
    uint256 internal constant RATE = 0.92e18;

    uint128 internal constant MAX_SINGLE = 2_000_000e6;
    uint128 internal constant MAX_EPOCH = 3_000_000e6;
    uint128 internal constant MAX_ROLLING = 5_000_000e6;
    uint128 internal constant AUTO_APPROVE = 1_000_000e6;
    uint32 internal constant MAX_DEVIATION_BPS = 30;

    bytes32 internal ROLE_OPERATOR;
    bytes32 internal ROLE_TREASURER;

    function setUp() public {
        (signerA, keyA) = makeAddrAndKey("signerA");

        usdc = new MockERC20("USD Coin", "USDC");
        eurc = new MockERC20("Euro Coin", "EURC");

        policy = new TreasuryPolicy(admin, 24 hours);
        attestor = new MockAttestationVerifier();
        verifier = new ReportVerifier(policy, attestor, MEASUREMENT);
        venue = new MockFxVenue();
        oracle = new MockPriceOracle();
        vault = new RebalanceVault(policy, verifier, address(usdc), venue, oracle);

        ROLE_OPERATOR = policy.OPERATOR();
        ROLE_TREASURER = policy.TREASURER();

        vm.startPrank(admin);
        policy.grantRole(policy.RISK_OFFICER(), riskOfficer);
        policy.grantRole(ROLE_TREASURER, treasurer);
        policy.grantRole(ROLE_OPERATOR, operator);
        policy.grantRole(policy.GUARDIAN(), guardian);
        verifier.setSigner(signerA, true);
        vm.stopPrank();

        _installPolicy();

        // Carnet et oracle alignés : spread nul et impact nul, pour que les tests de
        // bornes ne soient pas parasités par le coût d'exécution.
        venue.configure(address(usdc), address(eurc), RATE, 0, 0, 100_000_000e6);
        venue.configure(address(eurc), address(usdc), WAD * WAD / RATE, 0, 0, 100_000_000e6);
        oracle.set(address(usdc), address(eurc), RATE);
        oracle.set(address(eurc), address(usdc), WAD * WAD / RATE);

        eurc.mint(address(venue), 500_000_000e6);
        usdc.mint(address(venue), 500_000_000e6);
        usdc.mint(address(vault), 50_000_000e6);
        eurc.mint(address(vault), 50_000_000e6);
    }

    function _installPolicy() internal {
        TreasuryPolicy.CurrencyPolicy memory cp = TreasuryPolicy.CurrencyPolicy({
            lowerBand: 400_000e6,
            target: 600_000e6,
            upperBand: 900_000e6,
            maxSingleOrder: MAX_SINGLE,
            maxPerEpoch: MAX_EPOCH,
            maxRolling24h: MAX_ROLLING
        });
        vm.prank(riskOfficer);
        bytes32 idA = policy.queueCurrencyPolicy(address(eurc), cp);
        vm.prank(riskOfficer);
        bytes32 idB = policy.queueRiskParams(
            TreasuryPolicy.RiskParams({
                kappaBps: 1000,
                hDepegBps: 50,
                maxExecDeviationBps: MAX_DEVIATION_BPS,
                maxStalenessSec: 600,
                minEpochIntervalSec: 60,
                autoApproveThreshold: AUTO_APPROVE
            })
        );
        vm.warp(block.timestamp + 24 hours);
        policy.executeCurrencyPolicy(idA);
        policy.executeRiskParams(idB);
        vm.prank(riskOfficer);
        policy.commitBandParams(BAND_PARAMS);
    }

    /* ------------------------------------------------------------------ */
    /*                              Outillage                             */
    /* ------------------------------------------------------------------ */

    uint64 internal nextEpoch = 100;

    function _orders(address sell, address buy, uint128 amountIn, uint128 minOut)
        internal
        pure
        returns (RebalanceVault.Order[] memory o)
    {
        o = new RebalanceVault.Order[](1);
        o[0] =
            RebalanceVault.Order({sell: sell, buy: buy, amountIn: amountIn, minAmountOut: minOut});
    }

    function _commitment(RebalanceVault.Order[] memory o) internal pure returns (bytes32) {
        return keccak256(abi.encode(o, SALT));
    }

    function _report(RebalanceVault.Order[] memory o, uint128 gross)
        internal
        returns (ReportVerifier.RebalanceReport memory r)
    {
        r = ReportVerifier.RebalanceReport({
            epoch: nextEpoch++,
            nonce: 1,
            expiry: uint64(block.timestamp + 3600),
            inputsTimestamp: uint64(block.timestamp - 5),
            policyVersion: policy.policyVersion(),
            bandParamsHash: BAND_PARAMS,
            inputsHash: keccak256("inputs"),
            ordersCommitment: _commitment(o),
            esBeforeBps: 120,
            esAfterBps: 138,
            costEstimate: 10e6,
            grossNotional: gross
        });
    }

    function _submit(ReportVerifier.RebalanceReport memory r) internal returns (bytes32 id) {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(keyA, verifier.digest(r));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(rr, s, v);
        bytes memory att = abi.encode(MEASUREMENT, verifier.digest(r));
        vm.prank(operator);
        id = vault.submit(r, att, sigs);
    }

    /// @dev Cycle complet pour un achat d'EURC financé en USDC.
    function _run(uint128 amountIn) internal returns (bytes32 id, RebalanceVault.Order[] memory o) {
        o = _orders(address(usdc), address(eurc), amountIn, 0);
        id = _submit(_report(o, amountIn));
        if (vault.statusOf(id) == RebalanceVault.Status.AwaitingApproval) {
            vm.prank(treasurer);
            vault.approve(id);
        }
        vm.prank(operator);
        vault.execute(id, o, SALT);
    }

    /* ------------------------------------------------------------------ */
    /*                            Chemin nominal                          */
    /* ------------------------------------------------------------------ */

    function test_smallPlanExecutesWithoutApproval() public {
        uint128 amount = 500_000e6;
        uint256 eurcBefore = eurc.balanceOf(address(vault));
        uint256 usdcBefore = usdc.balanceOf(address(vault));

        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));
        assertEq(uint8(vault.statusOf(id)), uint8(RebalanceVault.Status.Ready));

        vm.prank(operator);
        vault.execute(id, o, SALT);

        assertEq(uint8(vault.statusOf(id)), uint8(RebalanceVault.Status.Settled));
        assertEq(usdc.balanceOf(address(vault)), usdcBefore - amount);
        assertEq(eurc.balanceOf(address(vault)), eurcBefore + amount * RATE / WAD);
    }

    function test_largePlanRequiresTreasurerApproval() public {
        uint128 amount = 1_500_000e6;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));

        assertEq(uint8(vault.statusOf(id)), uint8(RebalanceVault.Status.AwaitingApproval));

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                RebalanceVault.WrongStatus.selector,
                id,
                RebalanceVault.Status.AwaitingApproval,
                RebalanceVault.Status.Ready
            )
        );
        vault.execute(id, o, SALT);

        vm.prank(treasurer);
        vault.approve(id);
        vm.prank(operator);
        vault.execute(id, o, SALT);
        assertEq(uint8(vault.statusOf(id)), uint8(RebalanceVault.Status.Settled));
    }

    /// @dev L'opérateur ne peut pas s'auto-approuver : c'est la séparation des devoirs
    ///      appliquée au niveau du mouvement, et non plus seulement des paramètres.
    function test_operatorCannotApprove() public {
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), 1_500_000e6, 0);
        bytes32 id = _submit(_report(o, 1_500_000e6));
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(RebalanceVault.Unauthorized.selector, ROLE_TREASURER, operator)
        );
        vault.approve(id);
    }

    function test_strangerCannotSubmit() public {
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), 100_000e6, 0);
        ReportVerifier.RebalanceReport memory r = _report(o, 100_000e6);
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(keyA, verifier.digest(r));
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = abi.encodePacked(rr, s, v);
        bytes memory att = abi.encode(MEASUREMENT, verifier.digest(r));

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(RebalanceVault.Unauthorized.selector, ROLE_OPERATOR, stranger)
        );
        vault.submit(r, att, sigs);
    }

    /* ------------------------------------------------------------------ */
    /*                     Révélation de l'engagement (D6)                */
    /* ------------------------------------------------------------------ */

    function test_revealedOrdersMustMatchTheCommitment() public {
        uint128 amount = 500_000e6;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));

        RebalanceVault.Order[] memory tampered =
            _orders(address(usdc), address(eurc), amount + 1, 0);
        vm.prank(operator);
        vm.expectRevert();
        vault.execute(id, tampered, SALT);
    }

    /// @dev Sans sel, l'espace des plans quantifiés est assez petit pour être exploré
    ///      par force brute : l'engagement ne cacherait rien.
    function test_wrongSaltIsRejected() public {
        uint128 amount = 500_000e6;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));

        vm.prank(operator);
        vm.expectRevert();
        vault.execute(id, o, keccak256("mauvais sel"));
    }

    function test_emptyPlanIsRejected() public {
        RebalanceVault.Order[] memory empty = new RebalanceVault.Order[](0);
        bytes32 id = _submit(_report(empty, 0));
        vm.prank(operator);
        vm.expectRevert(RebalanceVault.EmptyPlan.selector);
        vault.execute(id, empty, SALT);
    }

    function test_planCannotSettleTwice() public {
        (bytes32 id, RebalanceVault.Order[] memory o) = _run(500_000e6);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                RebalanceVault.WrongStatus.selector,
                id,
                RebalanceVault.Status.Settled,
                RebalanceVault.Status.Ready
            )
        );
        vault.execute(id, o, SALT);
    }

    /* ------------------------------------------------------------------ */
    /*              Bornes de sanité, indépendantes du rapport            */
    /* ------------------------------------------------------------------ */

    /// @dev LE test qui porte la thèse du contrat. Le rapport est parfaitement signé,
    ///      parfaitement attesté, parfaitement cohérent avec la politique — et le coffre
    ///      le refuse quand même, parce qu'un moteur qui déraille produit exactement ce
    ///      genre de plan.
    function test_perfectlySignedButOversizedOrderIsRefused() public {
        uint128 amount = MAX_SINGLE + 1;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));
        vm.prank(treasurer);
        vault.approve(id);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                RebalanceVault.SingleOrderTooLarge.selector, address(eurc), amount, MAX_SINGLE
            )
        );
        vault.execute(id, o, SALT);
    }

    function test_epochCumulativeLimitIsEnforced() public {
        // Deux plans du même epoch : chacun sous le plafond unitaire, leur somme au-dessus
        // du plafond d'epoch.
        uint128 amount = 1_800_000e6;
        RebalanceVault.Order[] memory o1 = _orders(address(usdc), address(eurc), amount, 0);
        ReportVerifier.RebalanceReport memory r1 = _report(o1, amount);
        uint64 sharedEpoch = r1.epoch;
        bytes32 id1 = _submit(r1);
        vm.prank(treasurer);
        vault.approve(id1);
        vm.prank(operator);
        vault.execute(id1, o1, SALT);

        vm.warp(block.timestamp + 60);
        RebalanceVault.Order[] memory o2 = _orders(address(usdc), address(eurc), amount, 1);
        ReportVerifier.RebalanceReport memory r2 = _report(o2, amount);
        r2.epoch = sharedEpoch;
        r2.nonce = 2;
        bytes32 id2 = _submit(r2);
        vm.prank(treasurer);
        vault.approve(id2);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                RebalanceVault.EpochLimitExceeded.selector, uint256(amount) * 2, MAX_EPOCH
            )
        );
        vault.execute(id2, o2, SALT);
    }

    /// @dev La fenêtre est réellement glissante : franchir une frontière d'heure ne remet
    ///      pas le compteur à zéro. Une fenêtre à remise périodique laisserait passer deux
    ///      fois la limite de part et d'autre d'une frontière.
    function test_rollingWindowDoesNotResetAtHourBoundaries() public {
        uint128 amount = 1_800_000e6;
        for (uint256 i = 0; i < 2; i++) {
            _run(amount);
            vm.warp(block.timestamp + 1 hours);
        }
        assertEq(vault._rolling24h(), uint256(amount) * 2);

        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 7);
        bytes32 id = _submit(_report(o, amount));
        vm.prank(treasurer);
        vault.approve(id);
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                RebalanceVault.RollingLimitExceeded.selector, uint256(amount) * 3, MAX_ROLLING
            )
        );
        vault.execute(id, o, SALT);
    }

    function test_rollingWindowForgetsAfterTwentyFourHours() public {
        _run(1_800_000e6);
        assertEq(vault._rolling24h(), 1_800_000e6);
        vm.warp(block.timestamp + 25 hours);
        assertEq(vault._rolling24h(), 0);
    }

    function test_notionalMustMatchTheApprovedFigure() public {
        // Le rapport annonce un notionnel, le plan révélé en porte un autre : le
        // trésorier aurait approuvé un montant et l'opérateur en exécuterait un second.
        uint128 amount = 500_000e6;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        ReportVerifier.RebalanceReport memory r = _report(o, amount / 2);
        bytes32 id = _submit(r);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                RebalanceVault.NotionalMismatch.selector, uint256(amount), amount / 2
            )
        );
        vault.execute(id, o, SALT);
    }

    function test_legMustTouchTheNumeraire() public {
        RebalanceVault.Order[] memory o = _orders(address(eurc), address(eurc), 100_000e6, 0);
        bytes32 id = _submit(_report(o, 0));
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                RebalanceVault.LegMustTouchNumeraire.selector, address(eurc), address(eurc)
            )
        );
        vault.execute(id, o, SALT);
    }

    function test_unsupportedTokenIsRefused() public {
        MockERC20 gbpc = new MockERC20("GBP Coin", "GBPC");
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(gbpc), 100_000e6, 0);
        bytes32 id = _submit(_report(o, 100_000e6));
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(RebalanceVault.TokenNotSupported.selector, address(gbpc))
        );
        vault.execute(id, o, SALT);
    }

    /* ------------------------------------------------------------------ */
    /*                        Contrôle de déviation                       */
    /* ------------------------------------------------------------------ */

    /// @dev La protection la plus importante du système. Un carnet vidé ou un lieu
    ///      malveillant servirait au pire prix sans que rien ne le signale : le rapport
    ///      serait valide, les bornes de taille respectées, et la trésorerie perdrait la
    ///      différence en silence.
    function test_executionFarFromTheOracleIsRefused() public {
        // Le lieu se dégrade de 200 bps, l'oracle ne bouge pas.
        venue.configure(address(usdc), address(eurc), RATE, 200, 0, 100_000_000e6);

        uint128 amount = 500_000e6;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));

        vm.prank(operator);
        vm.expectRevert();
        vault.execute(id, o, SALT);
    }

    function test_smallDegradationWithinToleranceIsAccepted() public {
        venue.configure(address(usdc), address(eurc), RATE, 20, 0, 100_000_000e6);
        uint128 amount = 500_000e6;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));
        vm.prank(operator);
        vault.execute(id, o, SALT);
        assertEq(uint8(vault.statusOf(id)), uint8(RebalanceVault.Status.Settled));
    }

    /// @dev Obtenir mieux que l'oracle n'est pas un incident : le contrôle est unilatéral.
    function test_betterThanOracleIsNotAnIncident() public {
        oracle.set(address(usdc), address(eurc), RATE * 9000 / 10_000);
        uint128 amount = 500_000e6;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));
        vm.prank(operator);
        vault.execute(id, o, SALT);
        assertEq(uint8(vault.statusOf(id)), uint8(RebalanceVault.Status.Settled));
    }

    function test_missingOraclePriceBlocksExecution() public {
        MockPriceOracle empty = new MockPriceOracle();
        vm.prank(admin);
        vault.setVenue(venue, empty);

        uint128 amount = 500_000e6;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                RebalanceVault.OracleUnavailable.selector, address(usdc), address(eurc)
            )
        );
        vault.execute(id, o, SALT);
    }

    /* ------------------------------------------------------------------ */
    /*                             Suspension                             */
    /* ------------------------------------------------------------------ */

    function test_pauseBlocksExecution() public {
        uint128 amount = 500_000e6;
        RebalanceVault.Order[] memory o = _orders(address(usdc), address(eurc), amount, 0);
        bytes32 id = _submit(_report(o, amount));

        vm.prank(guardian);
        policy.pause();

        vm.prank(operator);
        vm.expectRevert(RebalanceVault.SystemPaused.selector);
        vault.execute(id, o, SALT);
    }

    function test_zeroAddressesAreRefused() public {
        vm.prank(admin);
        vm.expectRevert(RebalanceVault.ZeroAddress.selector);
        vault.setVenue(venue, MockPriceOracle(address(0)));
    }
}
