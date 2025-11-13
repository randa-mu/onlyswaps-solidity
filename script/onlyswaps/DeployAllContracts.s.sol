// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {
    BLSBN254SignatureScheme,
    DeployBN254SwapRequestSignatureScheme
} from "./single-deployment/DeployBN254SwapRequestSignatureScheme.s.sol";
import {DeployBN254ContractUpgradeSignatureScheme} from
    "./single-deployment/DeployBN254ContractUpgradeSignatureScheme.s.sol";
import {Router, DeployRouter} from "./single-deployment/DeployRouter.s.sol";
import {Permit2Relayer, DeployPermit2Relayer} from "./single-deployment/DeployPermit2Relayer.s.sol";
import {ERC20FaucetToken, DeployRUSD} from "./single-deployment/DeployRUSD.s.sol";
import {HookExecutor, DeployHookExecutor} from "./single-deployment/DeployHookExecutor.s.sol";

/// @title DeployAllContracts
/// @author Randamu
/// @notice A deployment contract that deploys all contracts required for
/// OnlySwaps.
contract DeployAllContracts is
    DeployBN254ContractUpgradeSignatureScheme,
    DeployBN254SwapRequestSignatureScheme,
    DeployPermit2Relayer,
    DeployRouter,
    DeployHookExecutor,
    DeployRUSD
{
    function run()
        public
        override (
            DeployBN254ContractUpgradeSignatureScheme,
            DeployBN254SwapRequestSignatureScheme,
            DeployPermit2Relayer,
            DeployRouter,
            DeployHookExecutor,
            DeployRUSD
        )
    {
        deployAll();
    }

    /// @notice Deploys all required contracts.
    /// @dev This function initializes multiple contracts and links them together as needed.
    /// @return bn254SwapRequestSignatureScheme The deployed instance of BN254SwapRequestSignatureScheme.
    /// @return bn254ContractUpgradeSignatureScheme The deployed instance of BN254ContractUpgradeSignatureScheme.
    /// @return permit2Relayer The deployed instance of Permit2Relayer.
    /// @return router The deployed instance of Router.
    /// @return hookExecutor The deployed instance of HookExecutor.
    /// @return rusd The deployed instance of RUSD.
    function deployAll()
        public
        returns (
            BLSBN254SignatureScheme bn254SwapRequestSignatureScheme,
            BLSBN254SignatureScheme bn254ContractUpgradeSignatureScheme,
            Permit2Relayer permit2Relayer,
            Router router,
            HookExecutor hookExecutor,
            ERC20FaucetToken rusd
        )
    {
        // for upgrades, run deployment script for individual contract in single-deployments
        bool isUpgrade = false;

        // BLSBN254SignatureScheme for swap requests
        bn254SwapRequestSignatureScheme = deployBN254SwapRequestSignatureScheme();
        // BLSBN254SignatureScheme for contract upgrades
        bn254ContractUpgradeSignatureScheme = deployBN254ContractUpgradeSignatureScheme();
        permit2Relayer = deployPermit2Relayer();
        // Router
        router = deployRouterProxy(
            isUpgrade, address(bn254SwapRequestSignatureScheme), address(bn254ContractUpgradeSignatureScheme)
        );
        // HookExecutor
        hookExecutor = deployHookExecutor(address(router));
        // RUSD
        rusd = deployRUSD();
    }
}
