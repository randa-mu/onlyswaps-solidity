// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {BN254SignatureScheme} from "bls-solidity/signature-schemes/BN254SignatureScheme.sol";
import {BLS} from "bls-solidity/libraries/BLS.sol";

/// @title BN254SignatureScheme contract
/// @author Randamu
/// @notice A contract that implements a BN254 signature scheme
contract BLSBN254SignatureScheme is BN254SignatureScheme {
    /// @notice Constructor for the BN254SignatureScheme contract.
    /// @param x The x-coordinate of the public key in G2.
    /// @param y The y-coordinate of the public key in G2.
    /// @param application The type of contract and version (e.g., "bridge-v1" for Bridge, "upgrade-v1" for Upgrade).
    constructor(uint256[2] memory x, uint256[2] memory y, string memory application)
        BN254SignatureScheme(BLS.g2Marshal(BLS.PointG2({x: x, y: y})), application)
    {}
}
