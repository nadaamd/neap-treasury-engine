// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ReportVerifier} from "../src/ReportVerifier.sol";
import {RebalanceVault} from "../src/RebalanceVault.sol";
import {TreasuryPolicy} from "../src/TreasuryPolicy.sol";
import {MockAttestationVerifier} from "../src/mocks/MockAttestationVerifier.sol";
import {MockFxVenue} from "../src/mocks/MockFxVenue.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/**
 * @title Conformance entre le moteur TypeScript et les contrats
 *
 * @dev Le moteur hors chaîne recalcule en TypeScript ce que Solidity calcule ici :
 *      encodage ABI, empreintes de type EIP-712, engagement sur les ordres, clé
 *      d'idempotence. Deux implémentations indépendantes du même encodage, confrontées
 *      à chaque exécution des tests.
 *
 *      Sans cette suite, une divergence — une virgule dans une signature de type, une
 *      extension de signe oubliée sur un entier négatif — ne se manifesterait qu'au
 *      moment où un rapport parfaitement valide se ferait rejeter, sans indice.
 *
 *      Le jeu de données est engendré par `node engine/scripts/fixtures.ts`.
 */
contract ConformanceTest is Test {
    string internal json;
    ReportVerifier internal verifier;
    RebalanceVault internal vault;

    function setUp() public {
        json = vm.readFile("test/fixtures/conformance.json");

        TreasuryPolicy policy = new TreasuryPolicy(address(this), 1 hours);
        verifier = new ReportVerifier(policy, new MockAttestationVerifier(), keccak256("m"));
        MockERC20 usdc = new MockERC20("USD Coin", "USDC");
        vault = new RebalanceVault(
            policy, verifier, address(usdc), new MockFxVenue(), new MockPriceOracle()
        );
    }

    function _orders() internal view returns (RebalanceVault.Order[] memory o) {
        o = new RebalanceVault.Order[](2);
        for (uint256 i = 0; i < 2; i++) {
            string memory base = string.concat(".orders[", vm.toString(i), "]");
            o[i] = RebalanceVault.Order({
                sell: vm.parseJsonAddress(json, string.concat(base, ".sell")),
                buy: vm.parseJsonAddress(json, string.concat(base, ".buy")),
                amountIn: uint128(vm.parseJsonUint(json, string.concat(base, ".amountIn"))),
                minAmountOut: uint128(vm.parseJsonUint(json, string.concat(base, ".minAmountOut")))
            });
        }
    }

    function _report() internal view returns (ReportVerifier.RebalanceReport memory r) {
        r = ReportVerifier.RebalanceReport({
            epoch: uint64(vm.parseJsonUint(json, ".report.epoch")),
            nonce: uint64(vm.parseJsonUint(json, ".report.nonce")),
            expiry: uint64(vm.parseJsonUint(json, ".report.expiry")),
            inputsTimestamp: uint64(vm.parseJsonUint(json, ".report.inputsTimestamp")),
            policyVersion: uint32(vm.parseJsonUint(json, ".report.policyVersion")),
            bandParamsHash: vm.parseJsonBytes32(json, ".report.bandParamsHash"),
            inputsHash: vm.parseJsonBytes32(json, ".report.inputsHash"),
            ordersCommitment: vm.parseJsonBytes32(json, ".report.ordersCommitment"),
            esBeforeBps: int32(vm.parseJsonInt(json, ".report.esBeforeBps")),
            esAfterBps: int32(vm.parseJsonInt(json, ".report.esAfterBps")),
            costEstimate: uint128(vm.parseJsonUint(json, ".report.costEstimate")),
            grossNotional: uint128(vm.parseJsonUint(json, ".report.grossNotional"))
        });
    }

    /// @dev L'encodage d'un tableau dynamique de structures statiques, suivi d'un mot
    ///      fixe : décalage de tête, longueur, puis quatre mots par ordre.
    function test_ordersCommitmentMatchesTheEngine() public view {
        bytes32 expected = vm.parseJsonBytes32(json, ".ordersCommitment");
        bytes32 salt = vm.parseJsonBytes32(json, ".salt");
        assertEq(keccak256(abi.encode(_orders(), salt)), expected);
    }

    function test_reportTypeHashMatchesTheEngine() public view {
        bytes32 expected = vm.parseJsonBytes32(json, ".reportTypeHash");
        bytes32 actual = keccak256(
            "RebalanceReport(uint64 epoch,uint64 nonce,uint64 expiry,uint64 inputsTimestamp,"
            "uint32 policyVersion,bytes32 bandParamsHash,bytes32 inputsHash,"
            "bytes32 ordersCommitment,int32 esBeforeBps,int32 esAfterBps,uint128 costEstimate,"
            "uint128 grossNotional)"
        );
        assertEq(actual, expected);
    }

    function test_domainTypeHashMatchesTheEngine() public view {
        assertEq(
            keccak256(
                "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
            ),
            vm.parseJsonBytes32(json, ".domainTypeHash")
        );
    }

    /**
     * @dev Le jeu contient volontairement une métrique **négative** : c'est l'extension de
     *      signe sur 256 bits qui est la plus facile à rater côté TypeScript, et son
     *      échec est parfaitement silencieux — l'encodage reste bien formé, seule
     *      l'empreinte diffère.
     */
    function test_reportStructHashMatchesTheEngine() public view {
        assertLt(vm.parseJsonInt(json, ".report.esAfterBps"), 0, "le jeu doit exercer un negatif");
        assertEq(verifier.structHash(_report()), vm.parseJsonBytes32(json, ".reportStructHash"));
    }

    function test_reportIdMatchesTheEngine() public view {
        assertEq(verifier.reportId(_report()), vm.parseJsonBytes32(json, ".reportId"));
    }

    /// @dev Le séparateur de domaine dépend de l'adresse déployée et ne peut donc pas
    ///      figurer dans un jeu statique. On vérifie ici sa construction ; la valeur
    ///      elle-même est confrontée au moteur par le scénario de bout en bout.
    function test_domainSeparatorIsBuiltFromTheDeployedAddress() public view {
        bytes32 expected = keccak256(
            abi.encode(
                vm.parseJsonBytes32(json, ".domainTypeHash"),
                keccak256("FLOAT"),
                keccak256("1"),
                block.chainid,
                address(verifier)
            )
        );
        assertEq(verifier.domainSeparator(), expected);
    }
}
