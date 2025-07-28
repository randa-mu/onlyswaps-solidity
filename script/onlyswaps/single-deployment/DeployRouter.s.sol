// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {Factory} from "../../shared/Factory.sol";
import {EnvReader} from "../../shared/EnvReader.sol";
import {JsonUtils} from "../../shared/JsonUtils.sol";
import {
    DeploymentParamsSelector,
    DeploymentParameters,
    DeploymentParamsCore
} from "../../shared/deployment-parameters/DeploymentParamsSelector.sol";

import {Constants} from "../libraries/Constants.sol";

import {Router} from "src/Router.sol";

/// @title DeployRouter
/// @dev Script for deploying Router contract.
contract DeployRouter is JsonUtils, EnvReader {
    function run() public virtual {
        address bn254SignatureVerifier = _readAddressFromJsonInput(
            string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json"),
            Constants.KEY_BN254_SIGNATURE_VERIFIER
        );

        deployRouter(bn254SignatureVerifier);
    }

    function deployRouter(address bn254SignatureVerifier) internal returns (Router router) {
        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        bytes memory code =
            abi.encodePacked(type(Router).creationCode, abi.encode(loadContractAdminFromEnv(), bn254SignatureVerifier));

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            address contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            router = Router(contractAddress);
        } else {
            router = new Router{salt: Constants.SALT}(loadContractAdminFromEnv(), bn254SignatureVerifier);
        }

        console.log("Router contract deployed at: ", address(router));

        _writeAddressToJsonInput(
            string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json"),
            Constants.KEY_ROUTER,
            address(router)
        );
    }
}
