// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TreasuryPolicy} from "../src/TreasuryPolicy.sol";
import {ReportVerifier} from "../src/ReportVerifier.sol";
import {MockAttestationVerifier} from "../src/mocks/MockAttestationVerifier.sol";

contract ReportVerifierTest is Test {
    TreasuryPolicy internal policy;
    ReportVerifier internal verifier;
    MockAttestationVerifier internal attestor;

    address internal admin = makeAddr("admin");
    address internal riskOfficer = makeAddr("riskOfficer");
    address internal guardian = makeAddr("guardian");

    address internal signerA;
    uint256 internal keyA;
    address internal signerB;
    uint256 internal keyB;
    address internal intruder;
    uint256 internal keyIntruder;

    bytes32 internal constant MEASUREMENT = keccak256("enclave-v1");
    bytes32 internal constant BAND_PARAMS = keccak256("band-params-v1");
    uint32 internal constant MAX_STALENESS = 60;
    uint32 internal constant MIN_EPOCH_INTERVAL = 300;

    uint256 internal constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        (signerA, keyA) = makeAddrAndKey("signerA");
        (signerB, keyB) = makeAddrAndKey("signerB");
        (intruder, keyIntruder) = makeAddrAndKey("intruder");

        policy = new TreasuryPolicy(admin, 24 hours);
        attestor = new MockAttestationVerifier();
        verifier = new ReportVerifier(policy, attestor, MEASUREMENT);

        vm.startPrank(admin);
        policy.grantRole(policy.RISK_OFFICER(), riskOfficer);
        policy.grantRole(policy.GUARDIAN(), guardian);
        verifier.setSigner(signerA, true);
        verifier.setSigner(signerB, true);
        vm.stopPrank();

        vm.prank(riskOfficer);
        bytes32 id = policy.queueRiskParams(
            TreasuryPolicy.RiskParams({
                kappaBps: 1000,
                hDepegBps: 50,
                maxExecDeviationBps: 30,
                maxStalenessSec: MAX_STALENESS,
                minEpochIntervalSec: MIN_EPOCH_INTERVAL,
                autoApproveThreshold: 1_000_000e6
            })
        );
        vm.warp(block.timestamp + 24 hours);
        policy.executeRiskParams(id);

        vm.prank(riskOfficer);
        policy.commitBandParams(BAND_PARAMS);
    }

    /* ------------------------------------------------------------------ */
    /*                              Outillage                             */
    /* ------------------------------------------------------------------ */

    function _report() internal view returns (ReportVerifier.RebalanceReport memory r) {
        r = ReportVerifier.RebalanceReport({
            epoch: 100,
            nonce: 1,
            expiry: uint64(block.timestamp + 120),
            inputsTimestamp: uint64(block.timestamp - 5),
            policyVersion: policy.policyVersion(),
            bandParamsHash: BAND_PARAMS,
            inputsHash: keccak256("inputs"),
            ordersCommitment: keccak256("orders"),
            esBeforeBps: 120,
            esAfterBps: 138,
            costEstimate: 42e6
        });
    }

    function _sign(uint256 pk, ReportVerifier.RebalanceReport memory r)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, verifier.digest(r));
        return abi.encodePacked(rr, s, v);
    }

    function _attestation(ReportVerifier.RebalanceReport memory r)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(MEASUREMENT, verifier.digest(r));
    }

    function _one(bytes memory sig) internal pure returns (bytes[] memory out) {
        out = new bytes[](1);
        out[0] = sig;
    }

    function _sortedPair(ReportVerifier.RebalanceReport memory r)
        internal
        view
        returns (bytes[] memory out)
    {
        out = new bytes[](2);
        if (signerA < signerB) {
            out[0] = _sign(keyA, r);
            out[1] = _sign(keyB, r);
        } else {
            out[0] = _sign(keyB, r);
            out[1] = _sign(keyA, r);
        }
    }

    /* ------------------------------------------------------------------ */
    /*                            Chemin nominal                          */
    /* ------------------------------------------------------------------ */

    function test_validReportIsAccepted() public {
        ReportVerifier.RebalanceReport memory r = _report();
        bytes32 id = verifier.verify(r, _attestation(r), _one(_sign(keyA, r)));

        assertEq(id, verifier.reportId(r));
        assertTrue(verifier.consumed(id));
        assertEq(verifier.lastEpoch(), 100);
        assertEq(verifier.reportOf(id).ordersCommitment, r.ordersCommitment);
    }

    function test_quorumOfTwoIsAccepted() public {
        vm.prank(admin);
        verifier.setThreshold(2);

        ReportVerifier.RebalanceReport memory r = _report();
        verifier.verify(r, _attestation(r), _sortedPair(r));
        assertTrue(verifier.consumed(verifier.reportId(r)));
    }

    /* ------------------------------------------------------------------ */
    /*                             Idempotence                            */
    /* ------------------------------------------------------------------ */

    /// @dev Rejouer un rapport signifierait un rééquilibrage exécuté deux fois, donc une
    ///      position doublée. C'est le défaut le plus coûteux imaginable ici.
    function test_replayIsRejected() public {
        ReportVerifier.RebalanceReport memory r = _report();
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyA, r));
        bytes32 id = verifier.verify(r, att, sigs);

        vm.expectRevert(abi.encodeWithSelector(ReportVerifier.ReportAlreadyConsumed.selector, id));
        verifier.verify(r, att, sigs);
    }

    /// @dev Deux plans différents au même epoch restent deux rapports distincts :
    ///      l'engagement sur les ordres entre dans la clé d'idempotence.
    function test_reportIdDependsOnTheOrdersCommitment() public view {
        ReportVerifier.RebalanceReport memory a = _report();
        ReportVerifier.RebalanceReport memory b = _report();
        b.ordersCommitment = keccak256("autre plan");
        assertTrue(verifier.reportId(a) != verifier.reportId(b));
    }

    /* ------------------------------------------------------------------ */
    /*                          Contrôles de temps                        */
    /* ------------------------------------------------------------------ */

    function test_expiredReportIsRejected() public {
        ReportVerifier.RebalanceReport memory r = _report();
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyA, r));
        vm.warp(uint256(r.expiry) + 1);
        vm.expectRevert();
        verifier.verify(r, att, sigs);
    }

    function test_staleInputsAreRejected() public {
        ReportVerifier.RebalanceReport memory r = _report();
        r.inputsTimestamp = uint64(block.timestamp - MAX_STALENESS - 1);
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyA, r));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReportVerifier.InputsStale.selector, r.inputsTimestamp, MAX_STALENESS
            )
        );
        verifier.verify(r, att, sigs);
    }

    function test_inputsFromTheFutureAreRejected() public {
        ReportVerifier.RebalanceReport memory r = _report();
        r.inputsTimestamp = uint64(block.timestamp + 1);
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyA, r));
        vm.expectRevert(
            abi.encodeWithSelector(ReportVerifier.InputsFromTheFuture.selector, r.inputsTimestamp)
        );
        verifier.verify(r, att, sigs);
    }

    function test_sequenceCannotGoBackwards() public {
        ReportVerifier.RebalanceReport memory first = _report();
        verifier.verify(first, _attestation(first), _one(_sign(keyA, first)));

        vm.warp(block.timestamp + MIN_EPOCH_INTERVAL);
        ReportVerifier.RebalanceReport memory second = _report();
        second.epoch = 99;
        second.nonce = 5;
        bytes memory att = _attestation(second);
        bytes[] memory sigs = _one(_sign(keyA, second));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReportVerifier.SequenceNotIncreasing.selector,
                uint64(99),
                uint64(5),
                uint64(100),
                uint64(1)
            )
        );
        verifier.verify(second, att, sigs);
    }

    /// @dev Cadence minimale : borne le préjudice d'un opérateur compromis et coupe court
    ///      à un attaquant qui provoquerait des rééquilibrages coûteux à répétition.
    function test_epochsCannotBeTooClose() public {
        ReportVerifier.RebalanceReport memory first = _report();
        verifier.verify(first, _attestation(first), _one(_sign(keyA, first)));

        vm.warp(block.timestamp + 10);
        ReportVerifier.RebalanceReport memory second = _report();
        second.epoch = 101;
        bytes memory att = _attestation(second);
        bytes[] memory sigs = _one(_sign(keyA, second));
        vm.expectRevert(
            abi.encodeWithSelector(ReportVerifier.EpochTooSoon.selector, 10, MIN_EPOCH_INTERVAL)
        );
        verifier.verify(second, att, sigs);
    }

    /**
     * @dev Le parcours de crise de la spec (§2.3) exige un déclenchement hors cycle :
     *      un choc de flux vide un corridor entre deux epochs et il faut décider tout de
     *      suite. Imposer la stricte croissance du seul epoch interdirait ce rapport
     *      supplémentaire — d'où la séquence sur le couple (epoch, nonce).
     */
    function test_outOfCycleReportIsAllowedWithinTheSameEpoch() public {
        ReportVerifier.RebalanceReport memory first = _report();
        verifier.verify(first, _attestation(first), _one(_sign(keyA, first)));

        vm.warp(block.timestamp + MIN_EPOCH_INTERVAL);
        ReportVerifier.RebalanceReport memory crisis = _report();
        crisis.nonce = first.nonce + 1;
        crisis.ordersCommitment = keccak256("plan de crise");
        crisis.expiry = uint64(block.timestamp + 120);
        crisis.inputsTimestamp = uint64(block.timestamp - 1);

        verifier.verify(crisis, _attestation(crisis), _one(_sign(keyA, crisis)));
        assertEq(verifier.lastNonce(), crisis.nonce);
        assertEq(verifier.lastEpoch(), first.epoch);
    }

    /* ------------------------------------------------------------------ */
    /*                     Cohérence avec la politique                    */
    /* ------------------------------------------------------------------ */

    function test_stalePolicyVersionIsRejected() public {
        ReportVerifier.RebalanceReport memory r = _report();
        r.policyVersion = r.policyVersion - 1;
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyA, r));
        vm.expectRevert();
        verifier.verify(r, att, sigs);
    }

    /// @dev Décision D5 : un rapport doit être lié au jeu de paramètres qui l'a produit.
    function test_bandParamsMismatchIsRejected() public {
        ReportVerifier.RebalanceReport memory r = _report();
        r.bandParamsHash = keccak256("autres parametres");
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyA, r));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReportVerifier.BandParamsMismatch.selector, r.bandParamsHash, BAND_PARAMS
            )
        );
        verifier.verify(r, att, sigs);
    }

    function test_pausedSystemRejectsEverything() public {
        vm.prank(guardian);
        policy.pause();
        ReportVerifier.RebalanceReport memory r = _report();
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyA, r));
        vm.expectRevert(ReportVerifier.SystemPaused.selector);
        verifier.verify(r, att, sigs);
    }

    /* ------------------------------------------------------------------ */
    /*                              Provenance                            */
    /* ------------------------------------------------------------------ */

    function test_unknownSignerIsRejected() public {
        ReportVerifier.RebalanceReport memory r = _report();
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyIntruder, r));
        vm.expectRevert(abi.encodeWithSelector(ReportVerifier.UnknownSigner.selector, intruder));
        verifier.verify(r, att, sigs);
    }

    /// @dev Le tri strict des signataires est ce qui rend impossible d'atteindre le
    ///      quorum en présentant deux fois la même signature.
    function test_duplicateSignatureCannotReachQuorum() public {
        vm.prank(admin);
        verifier.setThreshold(2);

        ReportVerifier.RebalanceReport memory r = _report();
        bytes memory sig = _sign(keyA, r);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = sig;
        sigs[1] = sig;

        bytes memory att = _attestation(r);
        vm.expectRevert(ReportVerifier.SignersNotSorted.selector);
        verifier.verify(r, att, sigs);
    }

    function test_unsortedSignaturesAreRejected() public {
        vm.prank(admin);
        verifier.setThreshold(2);

        ReportVerifier.RebalanceReport memory r = _report();
        bytes[] memory sorted = _sortedPair(r);
        bytes[] memory reversed = new bytes[](2);
        reversed[0] = sorted[1];
        reversed[1] = sorted[0];
        bytes memory att = _attestation(r);

        vm.expectRevert(ReportVerifier.SignersNotSorted.selector);
        verifier.verify(r, att, reversed);
    }

    function test_belowThresholdIsRejected() public {
        vm.prank(admin);
        verifier.setThreshold(2);

        ReportVerifier.RebalanceReport memory r = _report();
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyA, r));
        vm.expectRevert(abi.encodeWithSelector(ReportVerifier.NotEnoughSignatures.selector, 1, 2));
        verifier.verify(r, att, sigs);
    }

    /// @dev Sans la borne EIP-2 sur s, toute signature admet une seconde forme valide —
    ///      donc deux identifiants pour un même rapport, et l'idempotence tombe.
    function test_malleableSignatureIsRejected() public {
        ReportVerifier.RebalanceReport memory r = _report();
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(keyA, verifier.digest(r));
        bytes32 flippedS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(abi.encodePacked(rr, flippedS, flippedV));

        vm.expectRevert(ReportVerifier.MalleableSignature.selector);
        verifier.verify(r, att, sigs);
    }

    /* ------------------------------------------------------------------ */
    /*                             Attestation                            */
    /* ------------------------------------------------------------------ */

    /// @dev LE test qui justifie le paramètre `payloadHash` de l'interface. Sans lui,
    ///      une attestation valide pourrait être recyclée sur un tout autre rapport :
    ///      elle prouverait qu'une enclave existe, pas que *ce* contenu en est sorti.
    function test_attestationCannotBeRecycledOnAnotherReport() public {
        ReportVerifier.RebalanceReport memory a = _report();
        ReportVerifier.RebalanceReport memory b = _report();
        b.ordersCommitment = keccak256("plan substitue");

        bytes memory recycled = _attestation(a);
        bytes[] memory sigs = _one(_sign(keyA, b));
        bytes32 idB = verifier.reportId(b);

        vm.expectRevert(abi.encodeWithSelector(ReportVerifier.AttestationRejected.selector, idB));
        verifier.verify(b, recycled, sigs);
    }

    function test_rejectedAttestationBlocksTheReport() public {
        ReportVerifier.RebalanceReport memory r = _report();
        attestor.setShouldFail(true);
        bytes memory att = _attestation(r);
        bytes[] memory sigs = _one(_sign(keyA, r));
        vm.expectRevert(
            abi.encodeWithSelector(
                ReportVerifier.AttestationRejected.selector, verifier.reportId(r)
            )
        );
        verifier.verify(r, att, sigs);
    }

    /* ------------------------------------------------------------------ */
    /*                            Administration                          */
    /* ------------------------------------------------------------------ */

    function test_onlyAdminManagesSigners() public {
        vm.expectRevert(abi.encodeWithSelector(ReportVerifier.NotAdmin.selector, address(this)));
        verifier.setSigner(intruder, true);
    }

    function test_thresholdCannotExceedSignerCount() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ReportVerifier.ThresholdOutOfRange.selector, 3, 2));
        verifier.setThreshold(3);
    }

    function test_thresholdCannotBeZero() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ReportVerifier.ThresholdOutOfRange.selector, 0, 2));
        verifier.setThreshold(0);
    }

    /// @dev Une signature reste liée à sa chaîne : le séparateur de domaine est recalculé
    ///      si le chainid change, ce qui neutralise le rejeu après une bifurcation.
    function test_domainSeparatorFollowsTheChain() public {
        bytes32 before = verifier.domainSeparator();
        vm.chainId(block.chainid + 1);
        assertTrue(verifier.domainSeparator() != before);
    }
}
