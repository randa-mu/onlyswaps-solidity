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

import {BN254SignatureScheme} from "src/signature-scheme/BN254SignatureScheme.sol";

/// @title DeployBN254SwapRequestSignatureScheme
/// @dev Script for deploying BN254SwapRequestSignatureScheme contract.
contract DeployBN254SwapRequestSignatureScheme is JsonUtils, EnvReader {
    function run() public virtual {
        deployBN254SwapRequestSignatureScheme();
    }

    function deployBN254SwapRequestSignatureScheme() internal returns (BN254SignatureScheme bn254SignatureScheme) {
        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        bytes memory code = abi.encodePacked(
            type(BN254SignatureScheme).creationCode,
            abi.encode(deploymentParameters.blsSwapRequestPublicKey.x, deploymentParameters.blsSwapRequestPublicKey.y)
        );

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            address contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            bn254SignatureScheme = BN254SignatureScheme(contractAddress);
        } else {
            bn254SignatureScheme = new BN254SignatureScheme{salt: Constants.SALT}(
                deploymentParameters.blsSwapRequestPublicKey.x,
                deploymentParameters.blsSwapRequestPublicKey.y,
                BN254SignatureScheme.ContractType.Bridge
            );
        }

        console.log("Bn254SwapRequestSignatureScheme contract deployed at: ", address(bn254SignatureScheme));

        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(
            path, Constants.KEY_BN254_SWAP_REQUEST_SIGNATURE_SCHEME, address(bn254SignatureScheme)
        );
    }
}
