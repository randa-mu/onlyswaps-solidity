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

import {BN254SignatureScheme} from "src/signature-scheme/BN254SignatureScheme.sol";


/// @title DeployBN254SignatureScheme
/// @dev Script for deploying BN254SignatureScheme contract.
contract DeployBN254SignatureScheme is JsonUtils, EnvReader {
    function run() public virtual {
        deployBN254SignatureScheme();
    }

    function deployBN254SignatureScheme() internal returns (BN254SignatureScheme bn254SignatureScheme) {
        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        bytes memory code = abi.encodePacked(
            type(BN254SignatureScheme).creationCode,
            abi.encode(deploymentParameters.blsPublicKey.x, deploymentParameters.blsPublicKey.y)
        );

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            address contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            bn254SignatureScheme = BN254SignatureScheme(contractAddress);
        } else {
            bn254SignatureScheme = new BN254SignatureScheme{salt: Constants.SALT}(
                deploymentParameters.blsPublicKey.x, deploymentParameters.blsPublicKey.y
            );
        }

        console.log("Bn254SignatureScheme contract deployed at: ", address(bn254SignatureScheme));

        _writeAddressToJsonInput(
            string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json"),
            Constants.KEY_BN254_SIGNATURE_VERIFIER,
            address(bn254SignatureScheme)
        );
    }
}
