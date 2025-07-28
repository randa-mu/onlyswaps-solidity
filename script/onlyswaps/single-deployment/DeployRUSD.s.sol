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

import {ERC20Token} from "src/mocks/ERC20Token.sol";

/// @title DeployRUSD
/// @dev Script for deploying RUSD token contract.
contract DeployRUSD is JsonUtils, EnvReader {
    function run() public virtual {
        deployRUSD();
    }

    function deployRUSD() internal returns (ERC20Token rusd) {
        DeploymentParameters memory deploymentParameters = DeploymentParamsSelector.getDeploymentParams(block.chainid);

        bytes memory code = abi.encodePacked(
            type(ERC20Token).creationCode,
            abi.encode(
                deploymentParameters.tokenName, deploymentParameters.tokenSymbol, deploymentParameters.tokenDecimals
            )
        );

        vm.broadcast();
        if (deploymentParameters.customCREATE2FactoryContractAddress != DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER) {
            address contractAddress =
                Factory(deploymentParameters.customCREATE2FactoryContractAddress).deploy(Constants.SALT, code);
            rusd = ERC20Token(contractAddress);
        } else {
            rusd = new ERC20Token{salt: Constants.SALT}(
                deploymentParameters.tokenName, deploymentParameters.tokenSymbol, deploymentParameters.tokenDecimals
            );
        }

        console.log("RUSD contract deployed at: ", address(rusd));

        _writeAddressToJsonInput(
            string.concat(Constants.DEPLOYMENT_CONFIG_DIR, vm.toString(block.chainid), ".json"),
            Constants.KEY_RUSD,
            address(rusd)
        );
    }
}
