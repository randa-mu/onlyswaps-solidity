// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Script} from "forge-std/Script.sol";

import {Constants} from "./libraries/Constants.sol";

import {
    BN254SignatureScheme,
    DeployBN254SwapRequestSignatureScheme
} from "./single-deployment/DeployBN254SwapRequestSignatureScheme.s.sol";
import {DeployBN254ContractUpgradeSignatureScheme} from
    "./single-deployment/DeployBN254ContractUpgradeSignatureScheme.s.sol";
import {Router, DeployRouter} from "./single-deployment/DeployRouter.s.sol";
import {ERC20FaucetToken, DeployRUSD} from "./single-deployment/DeployRUSD.s.sol";

/// @title DeployAllContracts
/// @author Randamu
/// @notice A deployment contract that deploys all contracts required for
/// OnlySwaps.
contract DeployAllContracts is
    DeployBN254ContractUpgradeSignatureScheme,
    DeployBN254SwapRequestSignatureScheme,
    DeployRouter,
    DeployRUSD
{
    function run()
        public
        override (
            DeployBN254ContractUpgradeSignatureScheme, DeployBN254SwapRequestSignatureScheme, DeployRouter, DeployRUSD
        )
    {
        deployAll();
    }

    /// @notice Deploys all required contracts.
    /// @dev This function initializes multiple contracts and links them together as needed.
    /// @return bn254SwapRequestSignatureScheme The deployed instance of BN254SwapRequestSignatureScheme.
    /// @return bn254ContractUpgradeSignatureScheme The deployed instance of BN254ContractUpgradeSignatureScheme.
    /// @return router The deployed instance of Router.
    /// @return rusd The deployed instance of RUSD.
    function deployAll()
        public
        returns (
            BN254SignatureScheme bn254SwapRequestSignatureScheme,
            BN254SignatureScheme bn254ContractUpgradeSignatureScheme,
            Router router,
            ERC20FaucetToken rusd
        )
    {
        // for upgrades, run deployment script for individual contract in single-deployments
        bool isUpgrade = false;

        // BN254SignatureScheme for swap requests
        bn254SwapRequestSignatureScheme = deployBN254SwapRequestSignatureScheme();
        // BN254SignatureScheme for contract upgrades
        bn254ContractUpgradeSignatureScheme = deployBN254ContractUpgradeSignatureScheme();
        // Router
        router = deployRouterProxy(isUpgrade, address(bn254SwapRequestSignatureScheme), address(bn254ContractUpgradeSignatureScheme));
        // RUSD
        rusd = deployRUSD();
    }
}
