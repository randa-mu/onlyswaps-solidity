// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {BLS} from "bls-solidity/BLS.sol";

struct DeploymentParameters {
    BLS.PointG2 blsSwapRequestPublicKey;
    BLS.PointG2 blsContractUpgradePublicKey;
    string tokenName;
    string tokenSymbol;
    uint8 tokenDecimals;
    uint256 faucetAmount;
    uint256 verificationFeeBps;
    address customCREATE2FactoryContractAddress;
}

library DeploymentParamsCore {
    /// @dev The name of the testnet RUSD token.
    string constant TOKEN_NAME = "RUSD";

    /// @dev The symbol of the testnet RUSD token.
    string constant TOKEN_SYMBOL = "RUSD";

    /// @dev The number of decimals the token uses - e.g. 8, means to divide the token amount by 100,000,000 to get its user representation.
    uint8 constant TOKEN_DECIMALS = 18;

    /// @dev The amount of tokens to be minted to each address that requests tokens from the faucet.
    uint256 constant FAUCET_AMOUNT = 1000 ether;
    
    /// @dev The maximum basis points (BPS) for verification fees (i.e., 100% = 10,000 BPS).
    uint256 constant VERIFICATION_FEE_BPS = 500;

    /// @dev The default CREATE2 deployer address used by the `CREATE2Factory` contract.
    address constant DEFAULT_CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @notice Returns the BLS public key used for validating swap requests.
    function getBLSSwapRequestPublicKey() internal pure returns (BLS.PointG2 memory) {
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

    /// @notice Returns the BLS public key used for validating contract upgrades.
    function getBLSContractUpgradePublicKey() internal pure returns (BLS.PointG2 memory) {
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
