// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {TreasuryPolicy} from "../src/TreasuryPolicy.sol";
import {ReportVerifier} from "../src/ReportVerifier.sol";
import {RebalanceVault} from "../src/RebalanceVault.sol";
import {IFxVenue} from "../src/interfaces/IFxVenue.sol";
import {IPriceOracle} from "../src/interfaces/IPriceOracle.sol";
import {PausedFxVenue} from "../src/venues/PausedFxVenue.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockFxVenue} from "../src/mocks/MockFxVenue.sol";
import {MockPriceOracle} from "../src/mocks/MockPriceOracle.sol";
import {MockAttestationVerifier} from "../src/mocks/MockAttestationVerifier.sol";

/**
 * @title Déploiement de FLOAT
 *
 * @dev Trois profils depuis la même source — `anvil`, `arc-testnet`, `arc-mainnet`.
 *
 *      Ce qui distingue les profils n'est pas cosmétique. **Les mocks ne sont instanciés
 *      que hors mainnet, et c'est le script qui le garantit, pas une consigne.** Sur
 *      mainnet, l'USDC et l'EURC sont de vrais jetons ; y déployer un lieu d'exécution
 *      factice donnerait un contrat incapable de sourcer la moindre liquidité, et qui
 *      prendrait l'apparence d'un piège si quelqu'un l'alimentait.
 *
 *      Le profil mainnet déploie donc `PausedFxVenue` : un refus explicite, remplaçable
 *      par `setVenue` le jour où un lieu réel est accessible. Et il met le système en
 *      pause dans la foulée — ces contrats ne sont pas audités, les déployer est
 *      acceptable, y placer des fonds ne l'est pas.
 *
 *      Usage :
 *        forge script script/Deploy.s.sol --sig 'run(string)' anvil --broadcast
 *        forge script script/Deploy.s.sol --sig 'run(string)' arc-testnet --rpc-url $ARC_TESTNET_RPC --broadcast
 *        forge script script/Deploy.s.sol --sig 'run(string)' arc-mainnet  --rpc-url $ARC_MAINNET_RPC --broadcast
 */
contract Deploy is Script {
    uint256 internal constant TIMELOCK = 24 hours;

    struct Deployment {
        TreasuryPolicy policy;
        ReportVerifier verifier;
        RebalanceVault vault;
        address usdc;
        address eurc;
        address venue;
        address oracle;
    }

    function run(string calldata profile) external returns (Deployment memory d) {
        bool isMainnet = keccak256(bytes(profile)) == keccak256("arc-mainnet");

        address admin = vm.envOr("FLOAT_ADMIN", msg.sender);
        bytes32 measurement = vm.envOr("FLOAT_ENCLAVE_MEASUREMENT", keccak256("enclave-dev"));

        vm.startBroadcast();

        d.policy = new TreasuryPolicy(admin, TIMELOCK);
        d.verifier = new ReportVerifier(
            d.policy,
            // Sur mainnet, la vérification d'attestation est celle du consensus du DON
            // (D23) ; l'adaptateur local n'a rien à y faire.
            isMainnet
                ? MockAttestationVerifier(vm.envAddress("FLOAT_ATTESTATION_VERIFIER"))
                : new MockAttestationVerifier(),
            measurement
        );

        if (isMainnet) {
            d.usdc = vm.envAddress("ARC_USDC");
            d.eurc = vm.envAddress("ARC_EURC");
            d.venue = address(new PausedFxVenue());
            d.oracle = vm.envAddress("FLOAT_PRICE_ORACLE");
        } else {
            MockERC20 usdc = new MockERC20("USD Coin", "USDC");
            MockERC20 eurc = new MockERC20("Euro Coin", "EURC");
            MockFxVenue venue = new MockFxVenue();
            MockPriceOracle oracle = new MockPriceOracle();

            // 1 USDC → 0,92 EURC, spread de 2 bps, impact de 20 bps à pleine profondeur.
            venue.configure(address(usdc), address(eurc), 0.92e18, 2, 20, 5_000_000e6);
            venue.configure(address(eurc), address(usdc), 1.0869e18, 2, 20, 5_000_000e6);
            oracle.set(address(usdc), address(eurc), 0.92e18);
            oracle.set(address(eurc), address(usdc), 1.0869e18);
            usdc.mint(address(venue), 100_000_000e6);
            eurc.mint(address(venue), 100_000_000e6);

            d.usdc = address(usdc);
            d.eurc = address(eurc);
            d.venue = address(venue);
            d.oracle = address(oracle);
        }

        d.vault = new RebalanceVault(
            d.policy, d.verifier, d.usdc, IFxVenue(d.venue), IPriceOracle(d.oracle)
        );

        // Le déployeur se donne les rôles opérationnels hors mainnet pour que le
        // scénario de bout en bout puisse tourner sans cérémonie. Sur mainnet, seul
        // l'administrateur existe : les rôles sont attribués délibérément, un par un.
        if (!isMainnet) {
            d.policy.grantRole(d.policy.OPERATOR(), admin);
            d.policy.grantRole(d.policy.GUARDIAN(), admin);
            d.policy.grantRole(d.policy.RISK_OFFICER(), admin);
        } else {
            // Pause immédiate : ces contrats ne sont pas audités. Le déploiement est un
            // déploiement, pas une mise en exploitation.
            d.policy.grantRole(d.policy.GUARDIAN(), admin);
            d.policy.pause();
        }

        vm.stopBroadcast();

        console.log("profil          ", profile);
        console.log("TreasuryPolicy  ", address(d.policy));
        console.log("ReportVerifier  ", address(d.verifier));
        console.log("RebalanceVault  ", address(d.vault));
        console.log("venue           ", d.venue);
        console.log("oracle          ", d.oracle);
        console.log("USDC            ", d.usdc);
        console.log("EURC            ", d.eurc);
        if (isMainnet) console.log("etat            ", "EN PAUSE - lieu inerte, aucun fonds");
    }
}
