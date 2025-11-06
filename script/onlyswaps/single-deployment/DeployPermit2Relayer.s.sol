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

/// @title DeployPermit2Relayer
/// @dev Script for deploying the Permit2Relayer contract.
contract DeployPermit2Relayer is JsonUtils, EnvReader {
    function run() public virtual {
        deployPermit2Relayer();
    }

    function deployPermit2Relayer() internal returns (Permit2Relayer permit2Relayer) {
        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        bytes memory code = abi.encodePacked(type(Permit2Relayer).creationCode);

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            address contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            permit2Relayer = Permit2Relayer(contractAddress);
        } else {
            permit2Relayer = new Permit2Relayer{salt: Constants.SALT}();
        }

        console.log("Permit2Relayer contract deployed at: ", address(permit2Relayer));

        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(path, Constants.KEY_PERMIT2_RELAYER, address(permit2Relayer));
    }
}
