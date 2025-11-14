// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {console} from "forge-std/console.sol";

import {Factory} from "../../shared/Factory.sol";
import {EnvReader} from "../../shared/EnvReader.sol";
import {JsonUtils} from "../../shared/JsonUtils.sol";
import {DeploymentParamsSelector} from "../../shared/deployment-parameters/DeploymentParamsSelector.sol";
import {DeploymentParamsCore, DeploymentParameters} from "../../shared/deployment-parameters/DeploymentParamsCore.sol";

import {Constants} from "../libraries/Constants.sol";

import {HookExecutor} from "src/hook-executor/HookExecutor.sol";
import {Router} from "src/Router.sol";

/// @title DeployHookExecutor
/// @dev Script for deploying HookExecutor contract.
contract DeployHookExecutor is JsonUtils, EnvReader {
    function run() public virtual {
        string memory configPath = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        address routerProxy = _readAddressFromJsonInput(configPath, Constants.KEY_ROUTER_PROXY);
        deployHookExecutor(routerProxy);
    }

    function deployHookExecutor(address routerProxy) internal returns (HookExecutor hookExecutor) {
        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        _requireNonZero(routerProxy, "ROUTER_PROXY_ADDRESS");

        bytes memory code = abi.encodePacked(type(HookExecutor).creationCode, abi.encode(routerProxy));

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            address contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            hookExecutor = HookExecutor(contractAddress);
        } else {
            hookExecutor = new HookExecutor{salt: Constants.SALT}(routerProxy);
        }

        console.log("HookExecutor contract deployed at: ", address(hookExecutor));

        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(path, Constants.KEY_HOOK_EXECUTOR, address(hookExecutor));

        // set hook executor address in router
        Router router = Router(routerProxy);
        console.log("Setting Hook Executor address in Router:", address(hookExecutor));

        vm.broadcast();
        router.setHookExecutor(address(hookExecutor));
    }
}
