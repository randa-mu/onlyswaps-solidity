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

/// @title DeployRouter
/// @dev Script for deploying Router contract.
contract DeployRouter is JsonUtils, EnvReader {
    function run() public virtual {
        address bn254SignatureVerifier = _readAddressFromJsonInput(
            string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json"),
            Constants.KEY_BN254_SIGNATURE_SCHEME
        );

        deployRouter(bn254SignatureVerifier);
    }

    function deployRouter(address bn254SignatureVerifier) internal returns (Router router) {
        require(bn254SignatureVerifier != address(0), "BN254 verifier address must not be zero address");

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

        // Define the file path based on deployment config directory and current chain ID
        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");

        bool fileExists = _filePathExists(path);

        // If the file doesn't exist, create it by writing the address directly using a key
        if (!fileExists) {
            // Initialize the JSON file with the Router address
            _writeAddressToJsonInput(path, Constants.KEY_ROUTER, address(router));
        } else {
            // File exists — parse the contents into a struct for further modification
            OnlySwapsDeploymentAddresses memory data = _readOnlySwapsJsonToStruct(path);

            // If the address field is empty, write it using the write function
            if (data.routerAddress == address(0)) {
                _writeAddressToJsonInput(path, Constants.KEY_ROUTER, address(router));
            } else {
                // Update the existing struct with the new address
                data.routerAddress = address(router);

                // Write the updated struct back to the JSON file
                _writeOnlySwapsStructToJson(path, data);
            }
        }
    }
}
