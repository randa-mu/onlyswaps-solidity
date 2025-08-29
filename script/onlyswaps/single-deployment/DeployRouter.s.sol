// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {Factory} from "../../shared/Factory.sol";
import {EnvReader} from "../../shared/EnvReader.sol";
import {JsonUtils} from "../../shared/JsonUtils.sol";
import {OnlySwapsDeploymentAddresses} from "../../shared/TypesLib.sol";
import {
    DeploymentParamsSelector,
    DeploymentParameters,
    DeploymentParamsCore
} from "../../shared/deployment-parameters/DeploymentParamsSelector.sol";

import {Constants} from "../libraries/Constants.sol";

import {Router} from "src/Router.sol";

import {UUPSProxy} from "src/proxy/UUPSProxy.sol";
import {BN254SignatureScheme} from "src/signature-scheme/BN254SignatureScheme.sol";

/// @title DeployRouter
/// @dev Script for deploying upgradable Router contract using UUPSProxy.
contract DeployRouter is JsonUtils, EnvReader {
    function run() public virtual {
        // Read addresses for BLS signature verifiers from JSON config
        string memory configPath = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        address swapRequestBLSSigVerifier =
            _readAddressFromJsonInput(configPath, Constants.KEY_BN254_SWAP_REQUEST_SIGNATURE_SCHEME);
        address contractUpgradeBLSSigVerifier =
            _readAddressFromJsonInput(configPath, Constants.KEY_BN254_CONTRACT_UPGRADE_SIGNATURE_SCHEME);

        deployRouter(swapRequestBLSSigVerifier, contractUpgradeBLSSigVerifier);
    }

    function deployRouter(address swapRequestBLSSigVerifier, address contractUpgradeBLSSigVerifier)
        internal
        returns (Router router)
    {
        require(swapRequestBLSSigVerifier != address(0), "SwapRequest BLS verifier address must not be zero");
        require(contractUpgradeBLSSigVerifier != address(0), "ContractUpgrade BLS verifier address must not be zero");

        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        address admin = loadContractAdminFromEnv();

        // Deploy Router implementation
        Router routerImplementation;
        vm.broadcast();
        routerImplementation = new Router();

        // Deploy UUPSProxy with Router implementation
        UUPSProxy proxy;
        vm.broadcast();
        proxy = new UUPSProxy(address(routerImplementation), "");

        router = Router(address(proxy));

        // Initialize the proxy
        vm.broadcast();
        router.initialize(admin, swapRequestBLSSigVerifier, contractUpgradeBLSSigVerifier);

        console.log("Router (UUPSProxy) deployed at: ", address(router));

        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(path, Constants.KEY_ROUTER, address(router));
    }
}
