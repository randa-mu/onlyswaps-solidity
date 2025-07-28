// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {BLS} from "src/libraries/BLS.sol";

struct DeploymentParameters {
    BLS.PointG2 blsPublicKey;
    string tokenName;
    string tokenSymbol;
    uint8 tokenDecimals;
    address customCREATE2FactoryContractAddress;
}

library DeploymentParamsCore {
    string constant TOKEN_NAME = "RUSD";
    string constant TOKEN_SYMBOL = "RUSD";
    uint8 constant TOKEN_DECIMALS = 18;

    address constant DEFAULT_CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function getBLSPublicKey() internal pure returns (BLS.PointG2 memory) {
        return BLS.PointG2({
            x: [
                19466273993852079063924474392378816199685375459664529508122564849204533666468,
                21131687462638968537850845255670528066014536613738342153553860006061609469324
            ],
            y: [
                7578617840607454142936008614752231508238355116367494353476740252708767858492,
                5343514427465363660208643216752839104127697387077797304816316938005257664244
            ]
        });
    }
}
