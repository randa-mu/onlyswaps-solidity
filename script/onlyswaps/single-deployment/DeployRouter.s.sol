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
        bool isUpgrade = vm.envBool("IS_UPGRADE");
        // Read addresses for BLS signature verifiers from JSON config
        string memory configPath = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        address swapRequestBLSSigVerifier =
            _readAddressFromJsonInput(configPath, Constants.KEY_BN254_SWAP_REQUEST_SIGNATURE_SCHEME);
        address contractUpgradeBLSSigVerifier =
            _readAddressFromJsonInput(configPath, Constants.KEY_BN254_CONTRACT_UPGRADE_SIGNATURE_SCHEME);

        deployRouterProxy(isUpgrade, swapRequestBLSSigVerifier, contractUpgradeBLSSigVerifier);
    }

    function deployRouterProxy(bool isUpgrade, address swapRequestBLSSigVerifier, address contractUpgradeBLSSigVerifier)
        internal
        returns (Router router)
    {
        require(swapRequestBLSSigVerifier != address(0), "SwapRequest BLS verifier address must not be zero");
        require(contractUpgradeBLSSigVerifier != address(0), "ContractUpgrade BLS verifier address must not be zero");

        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        address implementation = deployRouterImplementation(deploymentParameters);

        if (isUpgrade) {
            // Upgrade logic
            router = executeContractUpgrade(implementation);
        } else {
            // Initial deployment logic
            router = executeInitialDeployment(
                implementation, swapRequestBLSSigVerifier, contractUpgradeBLSSigVerifier, deploymentParameters
            );
        }
    }

    function deployRouterImplementation(DeploymentParameters memory deploymentParameters)
        internal
        returns (address implementation)
    {
        bytes memory code = type(Router).creationCode;

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            implementation =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
        } else {
            Router router = new Router{salt: Constants.SALT}();
            implementation = address(router);
        }

        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(path, Constants.KEY_ROUTER_IMPLEMENTATION, implementation);

        console.log("Router implementation contract deployed at: ", implementation);
    }

    function executeInitialDeployment(
        address implementation,
        address swapRequestBLSSigVerifier,
        address contractUpgradeBLSSigVerifier,
        DeploymentParameters memory deploymentParameters
    ) internal returns (Router router) {
        vm.broadcast();
        address contractAddress;

        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            bytes memory code = abi.encodePacked(type(UUPSProxy).creationCode, abi.encode(implementation, ""));
            contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            router = Router(contractAddress);
        } else {
            UUPSProxy proxy = new UUPSProxy{salt: Constants.SALT}(implementation, "");
            router = Router(address(proxy));
            contractAddress = address(proxy);
        }

        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(path, Constants.KEY_ROUTER_PROXY, contractAddress);

        vm.broadcast();
        router.initialize(
            loadContractAdminFromEnv(),
            swapRequestBLSSigVerifier,
            contractUpgradeBLSSigVerifier,
            deploymentParameters.verificationFeeBps
        );

        console.log("Router (UUPSProxy) deployed at: ", contractAddress);
    }

    function executeContractUpgrade(address implementation) internal returns (Router router) {
        vm.broadcast();
        address proxyAddress = _readAddressFromJsonInput(
            string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json"),
            Constants.KEY_ROUTER_PROXY
        );

        require(proxyAddress != address(0), "proxyAddress must not be zero address");

        Router(proxyAddress).upgradeToAndCall(implementation, "");
        console.log("Router contract upgraded to new implementation at: ", implementation);
        router = Router(proxyAddress);
    }
}
