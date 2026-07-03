// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VectorMeritRegistry} from "../src/VectorMeritRegistry.sol";

contract DeployScript is Script {
    function run() external {
        // Chain-id guard: default to Mantle Sepolia (5003); override via env.
        uint256 expectedChainId = vm.envOr("EXPECTED_CHAIN_ID", uint256(5003));
        require(block.chainid == expectedChainId, "wrong chain");

        // OWNER_ADDRESS and ATTESTOR_ADDRESS MUST be different addresses.
        // The constructor reverts with OwnerIsAttestor if they are equal.
        address initialOwner = vm.envAddress("OWNER_ADDRESS");
        address initialAttestor = vm.envAddress("ATTESTOR_ADDRESS");

        vm.startBroadcast();
        VectorMeritRegistry registry = new VectorMeritRegistry(initialOwner, initialAttestor);
        vm.stopBroadcast();

        console2.log("VectorMeritRegistry deployed at:", address(registry));
        console2.log("Owner:", initialOwner);
        console2.log("Attestor:", initialAttestor);
    }
}
