// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {DeploymentParamsCore, DeploymentParameters} from "./DeploymentParamsCore.sol";

library DeploymentParamsCalibrationTestnet {
    function getDeploymentParams() internal pure returns (DeploymentParameters memory) {
        return DeploymentParameters({
            blsSwapRequestPublicKey: DeploymentParamsCore.getBLSSwapRequestPublicKey(),
            blsContractUpgradePublicKey: DeploymentParamsCore.getBLSContractUpgradePublicKey(),
            tokenName: DeploymentParamsCore.TOKEN_NAME,
            tokenSymbol: DeploymentParamsCore.TOKEN_SYMBOL,
            tokenDecimals: DeploymentParamsCore.TOKEN_DECIMALS,
            faucetAmount: DeploymentParamsCore.FAUCET_AMOUNT,
            verificationFeeBps: DeploymentParamsCore.VERIFICATION_FEE_BPS,
            customCREATE2FactoryContractAddress: 0xFFC8c99da81ac76789FC12671Dea0Ca93E1fcf18
        });
    }
}
