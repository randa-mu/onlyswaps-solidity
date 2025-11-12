// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

/// @dev Using the unlocked version of Permit2 to avoid incompatible compiler issues
/// @notice https://github.com/Uniswap/permit2/issues/260
import {SignatureTransfer} from "uniswap-permit2-unlocked/SignatureTransfer.sol";
import {AllowanceTransfer} from "uniswap-permit2-unlocked/AllowanceTransfer.sol";

/// @notice Mock Permit2
/// @dev For testing signature-based transfers in SignatureTransfer and allowance-based transfers in AllowanceTransfer.
/// @dev Users must approve Permit2 before calling any of the transfer functions.
contract Permit2 is SignatureTransfer, AllowanceTransfer {}
