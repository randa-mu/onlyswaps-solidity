// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

struct OnlySwapsDeploymentAddresses {
    address rusdFaucet;
    address routerProxyAddress;
    address routerImplementationAddress;
    address bn254SwapRequestSignatureSchemeAddress;
    address bn254ContractUpgradeSignatureSchemeAddress;
    address permit2RelayerAddress;
    address permit2Address;
    address hookExecutorAddress;
}
