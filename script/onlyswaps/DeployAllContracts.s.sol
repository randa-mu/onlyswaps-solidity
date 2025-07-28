// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Script} from "forge-std/Script.sol";

import {Constants} from "./libraries/Constants.sol";

import {BN254SignatureScheme, DeployBN254SignatureScheme} from "./single-deployment/DeployBN254SignatureScheme.s.sol";
import {Router, DeployRouter} from "./single-deployment/DeployRouter.s.sol";
import {ERC20FaucetToken, DeployRUSD} from "./single-deployment/DeployRUSD.s.sol";

/// @title DeployAllContracts
/// @author Randamu
/// @notice A deployment contract that deploys all contracts required for
/// OnlySwaps.
contract DeployAllContracts is DeployBN254SignatureScheme, DeployRouter, DeployRUSD {
    function run() public override (DeployBN254SignatureScheme, DeployRouter, DeployRUSD) {
        deployAll();
    }

    /// @notice Deploys all required contracts.
    /// @dev This function initializes multiple contracts and links them together as needed.
    /// @return bn254SignatureScheme The deployed instance of BN254SignatureVerifier.
    /// @return router The deployed instance of Router.
    /// @return rusd The deployed instance of RUSD.
    function deployAll() public returns (BN254SignatureScheme bn254SignatureScheme, Router router, ERC20FaucetToken rusd) {
        // BN254SignatureScheme
        bn254SignatureScheme = deployBN254SignatureScheme();
        // Router
        router = deployRouter(address(bn254SignatureScheme));
        // RUSD
        rusd = deployRUSD();
    }
}
