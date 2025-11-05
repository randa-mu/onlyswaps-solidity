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

import {BLSBN254SignatureScheme} from "src/signature-schemes/BLSBN254SignatureScheme.sol";

/// @title DeployBN254ContractUpgradeSignatureScheme
/// @dev Script for deploying BN254ContractUpgradeSignatureScheme contract.
contract DeployBN254ContractUpgradeSignatureScheme is JsonUtils, EnvReader {
    function run() public virtual {
        deployBN254ContractUpgradeSignatureScheme();
    }

    function deployBN254ContractUpgradeSignatureScheme()
        internal
        returns (BLSBN254SignatureScheme bn254SignatureScheme)
    {
        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        bytes memory code = abi.encodePacked(
            type(BLSBN254SignatureScheme).creationCode,
            abi.encode(
                deploymentParameters.blsContractUpgradePublicKey.x,
                deploymentParameters.blsContractUpgradePublicKey.y,
                "upgrade-v1"
            )
        );

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            address contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            bn254SignatureScheme = BLSBN254SignatureScheme(contractAddress);
        } else {
            bn254SignatureScheme = new BLSBN254SignatureScheme{
                salt: Constants.SALT
            }(
                deploymentParameters.blsContractUpgradePublicKey.x,
                deploymentParameters.blsContractUpgradePublicKey.y,
                "upgrade-v1"
            );
        }

        console.log("Bn254ContractUpgradeSignatureScheme contract deployed at: ", address(bn254SignatureScheme));

        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(
            path, Constants.KEY_BN254_CONTRACT_UPGRADE_SIGNATURE_SCHEME, address(bn254SignatureScheme)
        );
    }
}
