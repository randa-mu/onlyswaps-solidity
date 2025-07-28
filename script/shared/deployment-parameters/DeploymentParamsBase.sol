// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./DeploymentParamsCore.sol";

library DeploymentParamsBase {
    function getDeploymentParams() internal pure returns (DeploymentParameters memory) {
        return DeploymentParameters({
            blsPublicKey: DeploymentParamsCore.getBLSPublicKey(),
            tokenName: DeploymentParamsCore.TOKEN_NAME,
            tokenSymbol: DeploymentParamsCore.TOKEN_SYMBOL,
            tokenDecimals: DeploymentParamsCore.TOKEN_DECIMALS,
            customCREATE2FactoryContractAddress: DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER
        });
    }
}
