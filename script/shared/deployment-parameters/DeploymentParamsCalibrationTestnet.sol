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
            customCREATE2FactoryContractAddress: 0x93B465392F8B4993Db724690A3b527Ec035d3a9F,
            permit2Address: address(0)
        });
    }
}
