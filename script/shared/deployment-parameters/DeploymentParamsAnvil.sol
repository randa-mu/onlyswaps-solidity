// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {DeploymentParamsCore, DeploymentParameters} from "./DeploymentParamsCore.sol";

library DeploymentParamsAnvil {
    function getDeploymentParams() internal pure returns (DeploymentParameters memory) {
        return DeploymentParameters({
            blsSwapRequestPublicKey: DeploymentParamsCore.getBLSSwapRequestPublicKey(),
            blsContractUpgradePublicKey: DeploymentParamsCore.getBLSContractUpgradePublicKey(),
            tokenName: DeploymentParamsCore.TOKEN_NAME,
            tokenSymbol: DeploymentParamsCore.TOKEN_SYMBOL,
            tokenDecimals: DeploymentParamsCore.TOKEN_DECIMALS,
            faucetAmount: DeploymentParamsCore.FAUCET_AMOUNT,
            verificationFeeBps: DeploymentParamsCore.VERIFICATION_FEE_BPS,
            customCREATE2FactoryContractAddress: DeploymentParamsCore.DEFAULT_CREATE2_DEPLOYER
        });
    }
}
