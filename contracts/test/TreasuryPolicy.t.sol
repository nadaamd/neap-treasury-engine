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
     * The role constants are cached once and for all.
     *
     * Writing `ROLE_RISK_OFFICER` inside the arguments of an `expectRevert` triggers an
     * external call that consumes the `prank` set just before — and itself becomes "the
     * next call" that `expectRevert` watches. The test then fails for a reason unrelated
     * to what it claims to check.
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
    /*          Separation of duties — the central invariant              */
    /* ------------------------------------------------------------------ */

    /// @dev The most important test of the contract. It checks that the internal control
    ///      is a revert and not a UI convention.
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

    /// @dev The separation must be reversible: revoking one role must free the other,
    ///      otherwise a mistaken grant would be permanent.
    function test_separationOfDuties_isReleasedAfterRevocation() public {
        vm.startPrank(admin);
        policy.revokeRole(ROLE_TREASURER, treasurer);
        policy.grantRole(ROLE_RISK_OFFICER, treasurer);
        vm.stopPrank();
        assertTrue(policy.hasRole(ROLE_RISK_OFFICER, treasurer));
    }

    /// @dev The constraint applies only to the RISK_OFFICER / TREASURER pair. Holding
    ///      OPERATOR alongside either remains legitimate: executing is neither setting the
    ///      limits nor approving.
    function test_separationOfDuties_doesNotBlockOtherCombinations() public {
        vm.startPrank(admin);
        policy.grantRole(ROLE_OPERATOR, treasurer);
        policy.grantRole(ROLE_GUARDIAN, riskOfficer);
        vm.stopPrank();
        assertTrue(policy.hasRole(ROLE_OPERATOR, treasurer));
        assertTrue(policy.hasRole(ROLE_GUARDIAN, riskOfficer));
    }

    function testFuzz_separationOfDuties_holdsForAnyAddress(address account) public {
        // The fuzzer drew the fixture treasurer's address, which already holds TREASURER:
        // the *first* grant was then the reverting one, and the test failed on a
        // precondition it had never stated. Make it explicit.
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
    /*                            Access control                          */
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

    /// @dev A deliberate asymmetry: stopping is urgent, restarting never is.
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
    /*                       Timelocked changes                           */
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

    /// @dev Replaying an already consumed application must fail: the payload is erased,
    ///      so the identifier becomes unknown again.
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

    /// @dev Applying a matured change is open to any caller: the decision has already
    ///      been made and published, and mechanical execution is not a power.
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
    /*                     Parameter commitment (D5)                      */
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
    /*                          Risk parameters                           */
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
