// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

library Constants {
    bytes32 constant SALT = bytes32(uint256(123456));

    string constant SIGNATURE_SCHEME_ID = "BN254";

    string constant DEPLOYMENT_CONFIG_DIR = "/script/onlyswaps/json/";

    string constant KEY_RUSD = "rusdFaucet";
    string constant KEY_BN254_SWAP_REQUEST_SIGNATURE_SCHEME = "bn254SwapRequestSignatureSchemeAddress";
    string constant KEY_BN254_CONTRACT_UPGRADE_SIGNATURE_SCHEME = "bn254ContractUpgradeSignatureSchemeAddress";
    string constant KEY_PERMIT2_RELAYER = "permit2RelayerAddress";
    string constant KEY_PERMIT2 = "permit2Address";
    string constant KEY_ROUTER_PROXY = "routerProxyAddress";
    string constant KEY_ROUTER_IMPLEMENTATION = "routerImplementationAddress";
    string constant KEY_HOOK_EXECUTOR = "hookExecutorAddress";
}
