// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TreasuryPolicy} from "../src/TreasuryPolicy.sol";

contract TreasuryPolicyTest is Test {
    TreasuryPolicy internal policy;

    address internal admin = makeAddr("admin");
    address internal riskOfficer = makeAddr("riskOfficer");
    address internal treasurer = makeAddr("treasurer");
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");
    address internal usdc = makeAddr("usdc");

    uint256 internal constant DELAY = 24 hours;

    /**
     * Les constantes de rôle sont mises en cache une fois pour toutes.
     *
     * Écrire `ROLE_RISK_OFFICER` à l'intérieur des arguments d'un `expectRevert`
     * déclenche un appel externe qui consomme le `prank` posé juste avant — et devient
     * lui-même « l'appel suivant » que `expectRevert` surveille. Le test échoue alors
     * pour une raison qui n'a rien à voir avec ce qu'il prétend vérifier.
     */
    bytes32 internal ROLE_ADMIN;
    bytes32 internal ROLE_RISK_OFFICER;
    bytes32 internal ROLE_TREASURER;
    bytes32 internal ROLE_OPERATOR;
    bytes32 internal ROLE_GUARDIAN;

    function setUp() public {
        policy = new TreasuryPolicy(admin, DELAY);
        ROLE_ADMIN = policy.ADMIN();
        ROLE_RISK_OFFICER = policy.RISK_OFFICER();
        ROLE_TREASURER = policy.TREASURER();
        ROLE_OPERATOR = policy.OPERATOR();
        ROLE_GUARDIAN = policy.GUARDIAN();
        vm.startPrank(admin);
        policy.grantRole(ROLE_RISK_OFFICER, riskOfficer);
        policy.grantRole(ROLE_TREASURER, treasurer);
        policy.grantRole(ROLE_OPERATOR, operator);
        policy.grantRole(ROLE_GUARDIAN, guardian);
        vm.stopPrank();
    }

    function _bands() internal pure returns (TreasuryPolicy.CurrencyPolicy memory) {
        return TreasuryPolicy.CurrencyPolicy({
            lowerBand: 400_000e6,
            target: 600_000e6,
            upperBand: 900_000e6,
            maxSingleOrder: 2_000_000e6,
            maxPerEpoch: 5_000_000e6,
            maxRolling24h: 20_000_000e6
        });
    }

    /* ------------------------------------------------------------------ */
    /*            Séparation des devoirs — l'invariant central            */
    /* ------------------------------------------------------------------ */

    /// @dev C'est le test le plus important du contrat. Il vérifie que le contrôle
    ///      interne est un revert et non une convention d'interface.
    function test_separationOfDuties_treasurerCannotBecomeRiskOfficer() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryPolicy.SeparationOfDutiesViolated.selector, treasurer)
        );
        policy.grantRole(ROLE_RISK_OFFICER, treasurer);
    }

    function test_separationOfDuties_riskOfficerCannotBecomeTreasurer() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryPolicy.SeparationOfDutiesViolated.selector, riskOfficer)
        );
        policy.grantRole(ROLE_TREASURER, riskOfficer);
    }

    /// @dev La séparation doit être réversible : révoquer un rôle doit libérer l'autre,
    ///      sinon une erreur d'attribution serait définitive.
    function test_separationOfDuties_isReleasedAfterRevocation() public {
        vm.startPrank(admin);
        policy.revokeRole(ROLE_TREASURER, treasurer);
        policy.grantRole(ROLE_RISK_OFFICER, treasurer);
        vm.stopPrank();
        assertTrue(policy.hasRole(ROLE_RISK_OFFICER, treasurer));
    }

    /// @dev La contrainte ne porte que sur le couple RISK_OFFICER / TREASURER. Cumuler
    ///      OPERATOR avec l'un des deux reste légitime : exécuter n'est ni décider des
    ///      limites, ni approuver.
    function test_separationOfDuties_doesNotBlockOtherCombinations() public {
        vm.startPrank(admin);
        policy.grantRole(ROLE_OPERATOR, treasurer);
        policy.grantRole(ROLE_GUARDIAN, riskOfficer);
        vm.stopPrank();
        assertTrue(policy.hasRole(ROLE_OPERATOR, treasurer));
        assertTrue(policy.hasRole(ROLE_GUARDIAN, riskOfficer));
    }

    function testFuzz_separationOfDuties_holdsForAnyAddress(address account) public {
        // Le fuzzer a tiré l'adresse du trésorier du décor, qui détient déjà TREASURER :
        // c'était alors la *première* attribution qui révoquait, et le test échouait sur
        // une précondition qu'il n'avait jamais énoncée. On la rend explicite.
        vm.assume(account != address(0));
        vm.assume(!policy.hasRole(ROLE_TREASURER, account));
        vm.assume(!policy.hasRole(ROLE_RISK_OFFICER, account));
        vm.startPrank(admin);
        policy.grantRole(ROLE_RISK_OFFICER, account);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryPolicy.SeparationOfDutiesViolated.selector, account)
        );
        policy.grantRole(ROLE_TREASURER, account);
        vm.stopPrank();
    }

    /* ------------------------------------------------------------------ */
    /*                          Contrôle d'accès                          */
    /* ------------------------------------------------------------------ */

    function test_onlyAdminGrantsRoles() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryPolicy.Unauthorized.selector, ROLE_ADMIN, stranger)
        );
        policy.grantRole(ROLE_OPERATOR, stranger);
    }

    function test_treasurerCannotSetLimits() public {
        vm.prank(treasurer);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryPolicy.Unauthorized.selector, ROLE_RISK_OFFICER, treasurer
            )
        );
        policy.queueCurrencyPolicy(usdc, _bands());
    }

    function test_riskOfficerCannotPause() public {
        vm.prank(riskOfficer);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryPolicy.Unauthorized.selector, ROLE_GUARDIAN, riskOfficer)
        );
        policy.pause();
    }

    /* ------------------------------------------------------------------ */
    /*                        Suspension d'urgence                        */
    /* ------------------------------------------------------------------ */

    function test_guardianPausesImmediately() public {
        vm.prank(guardian);
        policy.pause();
        assertTrue(policy.paused());
    }

    /// @dev Asymétrie assumée : arrêter est urgent, redémarrer ne l'est jamais.
    function test_guardianCannotUnpause() public {
        vm.prank(guardian);
        policy.pause();
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(TreasuryPolicy.Unauthorized.selector, ROLE_ADMIN, guardian)
        );
        policy.unpause();
    }

    function test_adminUnpauses() public {
        vm.prank(guardian);
        policy.pause();
        vm.prank(admin);
        policy.unpause();
        assertFalse(policy.paused());
    }

    /* ------------------------------------------------------------------ */
    /*                       Changements différés                         */
    /* ------------------------------------------------------------------ */

    function test_changeCannotBeAppliedBeforeDelay() public {
        vm.prank(riskOfficer);
        bytes32 id = policy.queueCurrencyPolicy(usdc, _bands());
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryPolicy.TimelockNotElapsed.selector, id, block.timestamp + DELAY
            )
        );
        policy.executeCurrencyPolicy(id);
    }

    function test_changeAppliesAfterDelayAndBumpsVersion() public {
        vm.prank(riskOfficer);
        bytes32 id = policy.queueCurrencyPolicy(usdc, _bands());
        uint32 before = policy.policyVersion();

        vm.warp(block.timestamp + DELAY);
        policy.executeCurrencyPolicy(id);

        (uint128 lower, uint128 target, uint128 upper) = policy.bandsOf(usdc);
        assertEq(lower, 400_000e6);
        assertEq(target, 600_000e6);
        assertEq(upper, 900_000e6);
        assertEq(policy.policyVersion(), before + 1);
    }

    /// @dev Rejouer une application déjà consommée doit échouer : la charge utile est
    ///      effacée, donc l'identifiant redevient inconnu.
    function test_changeCannotBeReplayed() public {
        vm.prank(riskOfficer);
        bytes32 id = policy.queueCurrencyPolicy(usdc, _bands());
        vm.warp(block.timestamp + DELAY);
        policy.executeCurrencyPolicy(id);

        vm.expectRevert(abi.encodeWithSelector(TreasuryPolicy.ChangeNotQueued.selector, id));
        policy.executeCurrencyPolicy(id);
    }

    function test_unknownChangeIsRejected() public {
        bytes32 id = keccak256("inexistant");
        vm.expectRevert(abi.encodeWithSelector(TreasuryPolicy.ChangeNotQueued.selector, id));
        policy.executeCurrencyPolicy(id);
    }

    function test_adminCancelsQueuedChange() public {
        vm.prank(riskOfficer);
        bytes32 id = policy.queueCurrencyPolicy(usdc, _bands());
        vm.prank(admin);
        policy.cancel(id);

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(TreasuryPolicy.ChangeNotQueued.selector, id));
        policy.executeCurrencyPolicy(id);
    }

    /// @dev L'application d'un changement mûr est ouverte à tout appelant : la décision
    ///      a déjà été prise et publiée, l'exécution mécanique n'est pas un pouvoir.
    function test_anyoneCanApplyMatureChange() public {
        vm.prank(riskOfficer);
        bytes32 id = policy.queueCurrencyPolicy(usdc, _bands());
        vm.warp(block.timestamp + DELAY);
        vm.prank(stranger);
        policy.executeCurrencyPolicy(id);
        assertTrue(policy.supported(usdc));
    }

    function test_changesAreBlockedWhilePaused() public {
        vm.prank(riskOfficer);
        bytes32 id = policy.queueCurrencyPolicy(usdc, _bands());
        vm.warp(block.timestamp + DELAY);
        vm.prank(guardian);
        policy.pause();

        vm.expectRevert(TreasuryPolicy.SystemPaused.selector);
        policy.executeCurrencyPolicy(id);
    }

    /* ------------------------------------------------------------------ */
    /*                          Validation des bandes                     */
    /* ------------------------------------------------------------------ */

    function test_incoherentBandsAreRejectedAtQueueTime() public {
        TreasuryPolicy.CurrencyPolicy memory bad = _bands();
        bad.target = bad.upperBand + 1;
        vm.prank(riskOfficer);
        vm.expectRevert(TreasuryPolicy.InvalidBands.selector);
        policy.queueCurrencyPolicy(usdc, bad);
    }

    function testFuzz_onlyOrderedBandsAreAccepted(uint128 lower, uint128 target, uint128 upper)
        public
    {
        TreasuryPolicy.CurrencyPolicy memory p = _bands();
        p.lowerBand = lower;
        p.target = target;
        p.upperBand = upper;

        bool ordered = lower <= target && target <= upper;
        vm.prank(riskOfficer);
        if (!ordered) vm.expectRevert(TreasuryPolicy.InvalidBands.selector);
        policy.queueCurrencyPolicy(usdc, p);
    }

    function test_unsupportedTokenHasNoBands() public {
        vm.expectRevert(abi.encodeWithSelector(TreasuryPolicy.TokenNotSupported.selector, usdc));
        policy.bandsOf(usdc);
    }

    /* ------------------------------------------------------------------ */
    /*                     Engagement des paramètres (D5)                 */
    /* ------------------------------------------------------------------ */

    function test_riskOfficerCommitsBandParams() public {
        bytes32 h = keccak256("params-v1");
        vm.prank(riskOfficer);
        policy.commitBandParams(h);
        assertEq(policy.bandParamsHash(), h);
    }

    function test_operatorCannotCommitBandParams() public {
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                TreasuryPolicy.Unauthorized.selector, ROLE_RISK_OFFICER, operator
            )
        );
        policy.commitBandParams(keccak256("x"));
    }

    /* ------------------------------------------------------------------ */
    /*                        Paramètres de risque                        */
    /* ------------------------------------------------------------------ */

    function test_riskParamsApplyAfterDelay() public {
        TreasuryPolicy.RiskParams memory r = TreasuryPolicy.RiskParams({
            kappaBps: 1000,
            hDepegBps: 50,
            maxExecDeviationBps: 30,
            maxStalenessSec: 60,
            minEpochIntervalSec: 300,
            autoApproveThreshold: 1_000_000e6
        });
        vm.prank(riskOfficer);
        bytes32 id = policy.queueRiskParams(r);
        vm.warp(block.timestamp + DELAY);
        policy.executeRiskParams(id);

        (,,, uint32 staleness,,) = policy.riskParams();
        assertEq(staleness, 60);
    }
}
