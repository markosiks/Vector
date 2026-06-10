// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VectorMeritRegistry} from "../src/VectorMeritRegistry.sol";

contract DeployScript is Script {
    function run() external {
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
