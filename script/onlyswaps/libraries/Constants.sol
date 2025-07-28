// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

library Constants {
    bytes32 constant SALT = bytes32(uint256(10));

    string constant SIGNATURE_SCHEME_ID = "BN254";

    string constant DEPLOYMENT_CONFIG_DIR = "/script/onlyswaps/json/";

    string constant KEY_RUSD = "rusdAddress";
    string constant KEY_BN254_SIGNATURE_SCHEME = "bn254SignatureSchemeAddress";
    string constant KEY_ROUTER = "routerAddress";
}
