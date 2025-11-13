// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {console} from "forge-std/console.sol";

import {Factory} from "../../shared/Factory.sol";
import {EnvReader} from "../../shared/EnvReader.sol";
import {JsonUtils} from "../../shared/JsonUtils.sol";
import {DeploymentParamsSelector} from "../../shared/deployment-parameters/DeploymentParamsSelector.sol";
import {DeploymentParamsCore, DeploymentParameters} from "../../shared/deployment-parameters/DeploymentParamsCore.sol";

import {Constants} from "../libraries/Constants.sol";

import {ERC20FaucetToken} from "src/mocks/ERC20FaucetToken.sol";

/// @title DeployRUSD
/// @dev Script for deploying RUSD token contract.
contract DeployRUSD is JsonUtils, EnvReader {
    function run() public virtual {
        deployRUSD();
    }

    function deployRUSD() internal returns (ERC20FaucetToken rusd) {
        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        bytes memory code = abi.encodePacked(
            type(ERC20FaucetToken).creationCode,
            abi.encode(
                deploymentParameters.tokenName,
                deploymentParameters.tokenSymbol,
                deploymentParameters.tokenDecimals,
                deploymentParameters.faucetAmount,
                loadContractAdminFromEnv()
            )
        );

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            address contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            rusd = ERC20FaucetToken(contractAddress);
        } else {
            rusd = new ERC20FaucetToken{salt: Constants.SALT}(
                deploymentParameters.tokenName,
                deploymentParameters.tokenSymbol,
                deploymentParameters.tokenDecimals,
                deploymentParameters.faucetAmount,
                loadContractAdminFromEnv()
            );
        }

        console.log("RUSD contract deployed at: ", address(rusd));

        string memory path = string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json");
        _storeOnlySwapsAddressInJson(path, Constants.KEY_RUSD, address(rusd));
    }
}
