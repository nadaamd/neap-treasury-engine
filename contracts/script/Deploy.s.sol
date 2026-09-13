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
 * @title NEAP deployment
 *
 * @dev Three profiles from one source — `anvil`, `arc-testnet`, `arc-mainnet`.
 *
 *      What separates the profiles is not cosmetic. **The mocks are instantiated only
 *      off mainnet, and the script itself guarantees that, not a convention.** On
 *      mainnet, USDC and EURC are real tokens; deploying a fake venue there would give a
 *      contract unable to source any liquidity, which would look like a trap if anyone
 *      funded it.
 *
 *      The mainnet profile therefore deploys `PausedFxVenue`: an explicit refusal,
 *      replaceable through `setVenue` the day a real venue becomes reachable. And it
 *      pauses the system right afterwards — these contracts are not audited: deploying
 *      them is acceptable, putting funds in them is not.
 *
 *      Usage:
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

        address admin = vm.envOr("NEAP_ADMIN", msg.sender);
        bytes32 measurement = vm.envOr("NEAP_ENCLAVE_MEASUREMENT", keccak256("enclave-dev"));

        vm.startBroadcast();

        d.policy = new TreasuryPolicy(admin, TIMELOCK);
        d.verifier = new ReportVerifier(
            d.policy,
            // On mainnet, attestation verification is DON consensus (D23); the local
            // adapter has no business there.
            isMainnet
                ? MockAttestationVerifier(vm.envAddress("NEAP_ATTESTATION_VERIFIER"))
                : new MockAttestationVerifier(),
            measurement
        );

        if (isMainnet) {
            d.usdc = vm.envAddress("ARC_USDC");
            d.eurc = vm.envAddress("ARC_EURC");
            d.venue = address(new PausedFxVenue());
            d.oracle = vm.envAddress("NEAP_PRICE_ORACLE");
        } else {
            MockERC20 usdc = new MockERC20("USD Coin", "USDC");
            MockERC20 eurc = new MockERC20("Euro Coin", "EURC");
            MockFxVenue venue = new MockFxVenue();
            MockPriceOracle oracle = new MockPriceOracle();

            // 1 USDC → 0.92 EURC, 2 bps spread, 20 bps impact at full depth.
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

        // The deployer grants itself the operational roles off mainnet so the end-to-end
        // scenario can run without ceremony. On mainnet only the administrator exists:
        // roles are granted deliberately, one at a time.
        if (!isMainnet) {
            d.policy.grantRole(d.policy.OPERATOR(), admin);
            d.policy.grantRole(d.policy.GUARDIAN(), admin);
            d.policy.grantRole(d.policy.RISK_OFFICER(), admin);
        } else {
            // Immediate pause: these contracts are not audited. A deployment is a
            // deployment, not a go-live.
            d.policy.grantRole(d.policy.GUARDIAN(), admin);
            d.policy.pause();
        }

        vm.stopBroadcast();

        console.log("profile         ", profile);
        console.log("TreasuryPolicy  ", address(d.policy));
        console.log("ReportVerifier  ", address(d.verifier));
        console.log("RebalanceVault  ", address(d.vault));
        console.log("venue           ", d.venue);
        console.log("oracle          ", d.oracle);
        console.log("USDC            ", d.usdc);
        console.log("EURC            ", d.eurc);
        if (isMainnet) console.log("state           ", "PAUSED - inert venue, no funds");
    }
}
