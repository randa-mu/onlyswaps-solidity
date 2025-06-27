// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

/// @notice Parameters used to estimate fees required to send tokens to a destination chain.
struct FeeParams {
    uint32 dstChainId;
    uint64 amountIn;
}

/// @title Interface for estimating fees required to send tokens to a destination chain.
interface ISwapFeeLib {
    /// @notice Apply a fee for a given request, allowing for state modification.
    function applyFee(FeeParams calldata _params) external returns (uint64 amountOut);
    /// @notice Apply a fee for a given request, without modifying state.
    function applyFeeView(FeeParams calldata _params) external view returns (uint64 amountOut);
}
