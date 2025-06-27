// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

/// @notice Struct used to map tokens across chains for multi-chain swap support
/// e.g., tokenIn = USDC (Ethereum) ⟶ tokenOut = DAI (Arbitrum).
struct SupportedSwap {
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

    /// @notice Returns a list of all fulfilled requests ids on the dst chain.
    /// Request id is a hash of the bridge request message.
    function getAllFulfilledRequestIds() external view returns (bytes32[] memory);

    /// @notice Returns a list of all unfulfilled requests ids on the src chain.
    /// Request id is a hash of the bridge request message.
    function getAllUnfulfilledRequestIds() external view returns (bytes32[] memory);

    /// @notice Rescue ERC20 tokens not tracked in internal mappings.
    /// @param token Address of ERC20 token to rescue.
    /// @param to Recipient address.
    /// @param amount Amount to rescue.
    function rescueERC20(address token, address to, uint256 amount) external;

    /// @notice Sets the BLS signature validator contract.
    /// @param _blsValidator Address of new BLS validator.
    function setBlsValidator(address _blsValidator) external;

    /// @notice Sets token mapping between chain pairs.
    /// @param supportedSwap Struct composed of the srcChainId, tokenIn, dstChainId, tokenOut.
    function setTokenMapping(SupportedSwap memory supportedSwap) external;

    /// @notice Sets Solver fee in basis points.
    /// @param _solverFeeBps Solver fee in basis points.
    /// @param dstChainId The related chain id. To incentivise solvers on a specific chain.
    function setSolverFeeBps(uint256 _solverFeeBps, uint32 dstChainId) external;

    /// @notice Sets swap fee in basis points for a specific destination chain id.
    /// @param _swapFeeBps Swap fee in basis points.
    /// @param dstChainId The related chain id. To incentivise solvers on a specific chain.
    function setSwapFeeBps(uint256 _swapFeeBps, uint32 dstChainId) external;

    /// @notice Returns the current chain ID.
    function getChainID() external view returns (uint256);
}
