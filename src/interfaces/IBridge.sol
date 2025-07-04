// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IBridge {
    /// @notice Structure to store details of a fulfilled transfer request
    struct TransferReceipt {
        bytes32 requestId; // Reference to the original request on the source chain
        uint256 srcChainId; // Source chain ID from which the request originated
        bool fulfilled; // Whether the transfer has been delivered
        address solver; // Address that fulfilled the request
        uint256 amountOut; // Amount delivered to the recipient (after fees)
        uint256 fulfilledAt; // Timestamp when the request was fulfilled
    }

    /// @notice Emitted when a bridge receipt is recorded
    /// @param requestId The unique ID of the bridge transfer request
    /// @param srcChainId The source chain ID
    /// @param fulfilled Whether the request was fulfilled
    /// @param solver The address that fulfilled the transfer
    /// @param amountOut The amount transferred to the recipient
    /// @param fulfilledAt The timestamp of fulfillment
    event BridgeReceipt(
        bytes32 indexed requestId,
        uint256 indexed srcChainId,
        bool fulfilled,
        address indexed solver,
        uint256 amountOut,
        uint256 fulfilledAt
    );

    /// @notice Relays tokens to the recipient and stores a receipt
    /// @param token The token being relayed
    /// @param recipient The target recipient of the tokens
    /// @param amount The net amount delivered (after fees)
    /// @param requestId The original request ID from the source chain
    /// @param srcChainId The ID of the source chain where the request originated
    function relayTokens(address token, address recipient, uint256 amount, bytes32 requestId, uint256 srcChainId)
        external;

    /// @notice Checks whether a bridge request has been fulfilled
    /// @param bridgeRequestId The request ID to check
    /// @return True if fulfilled, false otherwise
    function isFulfilled(bytes32 bridgeRequestId) external view returns (bool);

    /// @notice Allows owner to recover tokens mistakenly sent to the contract
    /// @param token The ERC20 token to rescue
    /// @param to The address to send rescued tokens to
    /// @param amount The amount of tokens to rescue
    function rescueERC20(address token, address to, uint256 amount) external;

    /// @notice View a transfer receipt by requestId
    /// @param requestId The request ID of the transfer
    /// @return receipt The stored TransferReceipt struct
    function receipts(bytes32 requestId) external view returns (bytes32, uint256, bool, address, uint256, uint256);
}
