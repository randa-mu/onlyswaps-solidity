// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console} from "forge-std/console.sol";
import {Script} from "forge-std/Script.sol";

import {EnvReader} from "../../shared/EnvReader.sol";

import {Router} from "src/Router.sol";

contract GrantRoleScript is Script, EnvReader {
    // Role IDs
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    function run() external {
        console.log("GrantRoleScript starting on chain:", block.chainid);

        // Load environment variables
        address contractAddress = vm.envAddress("ROUTER_CONTRACT_ADDRESS");
        _requireNonZero(contractAddress, "ROUTER_CONTRACT_ADDRESS");

        address grantee = vm.envAddress("GRANTEE_WALLET");
        _requireNonZero(grantee, "GRANTEE_WALLET");

        console.log("Using contract:", contractAddress);
        console.log("Granting roles to:", grantee);

        // Contract instance
        Router target = Router(contractAddress);

        // Broadcasted tx 1: grant ADMIN_ROLE
        vm.broadcast();
        target.grantRole(ADMIN_ROLE, grantee);
        console.log("Granted ADMIN_ROLE");

        // Broadcasted tx 2: grant DEFAULT_ADMIN_ROLE
        vm.broadcast();
        target.grantRole(DEFAULT_ADMIN_ROLE, grantee);
        console.log("Granted DEFAULT_ADMIN_ROLE");

        console.log("Role granting completed!");
    }
}
