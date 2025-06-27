// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

/// @notice Struct used to map tokens across chains for multi-chain swap support
/// e.g., tokenIn = USDC (Ethereum) ⟶ tokenOut = DAI (Arbitrum).
struct SupportedSwaps {
    uint32 srdChainId;
    address tokenIn;
    uint32 dstChainId;
    address tokenOut;
}

struct TransferIntent {
    address sender; // Address initiating the transfer
    address tokenIn; // Token on source chain
    address tokenOut; // Token on destination chain
    uint256 amountIn; // Amount sent in
    uint256 minAmountOut; // Minimum acceptable amount after fees/slippage
    uint256 dstChainId; // EVM chain ID of the destination chain
    address dstRecipient; // Final wallet to receive tokens
    address refundAddress; // Address to refund to should the transfer fail for any reason
    uint256 timestamp; // When the intent was created
    bytes32 intentId; // Unique identifier
}

struct TransferReceipt {
    bytes32 intentId; // Reference to the original intent
    bool fulfilled; // Whether the transfer was delivered
    address solver; // Who fulfilled it
    uint256 amountOut; // Final amount delivered
    uint256 fulfilledAt; // Timestamp of delivery
}

interface ISwap {
    /// @notice Called by the user to register a cross-chain transfer intent
    function submitIntent(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 dstChainId,
        address dstRecipient,
        address refundAddress
    ) external returns (bytes32 intentId);

    function estimateFee(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 dstChainId,
        address dstRecipient,
        address refundAddress
    ) external returns (uint64 fee);

    /// @notice View transfer intent by ID
    function getIntent(bytes32 intentId) external view returns (TransferIntent memory);

    /// @notice View receipt for a completed transfer
    function getReceipt(bytes32 intentId) external view returns (TransferReceipt memory);
}
