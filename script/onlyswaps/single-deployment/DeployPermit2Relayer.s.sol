// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {console} from "forge-std/console.sol";

import {Factory} from "../../shared/Factory.sol";
import {EnvReader} from "../../shared/EnvReader.sol";
import {JsonUtils} from "../../shared/JsonUtils.sol";
import {DeploymentParamsCore, DeploymentParameters} from "../../shared/deployment-parameters/DeploymentParamsCore.sol";
import {DeploymentParamsSelector} from "../../shared/deployment-parameters/DeploymentParamsSelector.sol";

import {Constants} from "../libraries/Constants.sol";

import {Permit2Relayer} from "src/Permit2Relayer.sol";
import {Permit2} from "src/mocks/Permit2.sol";

/// @title DeployPermit2Relayer
/// @dev Script for deploying the Permit2Relayer contract.
contract DeployPermit2Relayer is JsonUtils, EnvReader {
    function run() public virtual {
        deployPermit2Relayer();
    }

    function deployPermit2Relayer() internal returns (Permit2Relayer permit2Relayer) {
        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        address permit2Address = deploymentParameters.permit2Address;

        if (permit2Address == address(0)) {
            if (
                deploymentParameters.customCREATE2FactoryContractAddress
                    != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER
            ) {
                // Deploy new Permit2 contract using CREATE2 factory
                bytes memory permit2Code = abi.encodePacked(type(Permit2).creationCode);

                vm.broadcast();
                permit2Address = Factory(deploymentParameters.customCREATE2FactoryContractAddress)
                    .deploy(Constants.SALT, permit2Code);
                console.log("Deployed new Permit2 at: ", permit2Address);
            } else {
                // Deploy new Permit2 contract directly
                vm.broadcast();
                permit2Address = address(new Permit2{salt: Constants.SALT}());
                console.log("Deployed new Permit2 at: ", permit2Address);
            }
        } else {
            console.log("Using existing Permit2 at: ", permit2Address);
        }

        // Write permit2 address to JSON
        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(path, Constants.KEY_PERMIT2, permit2Address);

        bytes memory code = abi.encodePacked(type(Permit2Relayer).creationCode, abi.encode(permit2Address));

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            address contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            permit2Relayer = Permit2Relayer(contractAddress);
        } else {
            permit2Relayer = new Permit2Relayer{salt: Constants.SALT}(permit2Address);
        }

        console.log("Permit2Relayer contract deployed at: ", address(permit2Relayer));

        path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(path, Constants.KEY_PERMIT2_RELAYER, address(permit2Relayer));
    }
}
