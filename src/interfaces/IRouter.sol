// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IRouter {
    // -------- Structs --------

    struct TransferParams {
        address sender;         // Address initiating the swap on the source chain
        address recipient;      // Address to receive tokens on the destination chain
        address token;          // Token address being transferred
        uint256 amount;         // Amount to be received by the recipient on the destination chain
        uint256 srcChainId;     // Source chain ID where the request originated
        uint256 dstChainId;     // Destination chain ID where tokens will be delivered
        uint256 swapFee;        // Total swap fee deducted from the amount
        uint256 solverFee;      // Portion of swapFee paid to the solver
        uint256 nonce;          // Unique nonce to prevent replay attacks
        bool executed;          // Whether the transfer has been executed
    }

    /// @notice Structure to store details of a fulfilled transfer request
    struct TransferReceipt {
        bytes32 requestId; // Reference to the original request on the source chain
        uint256 srcChainId; // Source chain ID from which the request originated
        address token; // Token being transferred
        bool fulfilled; // Whether the transfer has been delivered
        address solver; // Address that fulfilled the request
        address recipient; // Recipient of the tokens on the destination chain
        uint256 amount; // Amount delivered to the recipient (after fees)
        uint256 fulfilledAt; // Timestamp when the request was fulfilled
    }

    /// @notice Emitted when a bridge receipt is recorded
    /// @param requestId The unique ID of the bridge transfer request
    /// @param srcChainId The source chain ID
    /// @param solver The address that fulfilled the transfer
    /// @param recipient The address that received the tokens on the destination chain
    /// @param amount The amount transferred to the recipient
    /// @param fulfilledAt The timestamp when the transfer was fulfilled
    event BridgeReceipt(
        bytes32 indexed requestId,
        uint256 indexed srcChainId,
        address indexed token,
        address solver,
        address recipient,
        uint256 amount,
        uint256 fulfilledAt
    );

    // -------- Events --------

    /// @notice Emitted when a new swap (request) is created
    /// @param requestId Hash of transfer parameters
    /// @param message Encoded payload for off-chain solver
    event SwapRequested(bytes32 indexed requestId, bytes message);

    /// @notice Emitted when a message is successfully fulfilled by a solver
    /// @param requestId Hash of the transfer parameters
    event SwapRequestFulfilled(bytes32 indexed requestId);

    /// @notice Emitted when the fee is updated for a request by the sender
    event SwapRequestFeeUpdated(bytes32 indexed requestId, address token, uint256 newSwapFee, uint256 newSolverFee);

    /// @notice Emitted when the swap fee Bps is updated
    event SwapFeeBpsUpdated(uint256 newFeeBps);

    /// @notice Emitted when the bls validator contract is updated
    event BLSValidatorUpdated(address indexed blsValidator);

    /// @notice Emitted when the destination chain id is permitted
    event DestinationChainIdPermitted(uint256 chainId);

    /// @notice Emitted when the destination chain id is blocked
    event DestinationChainIdBlocked(uint256 chainId);

    /// @notice Emitted when a pair of source and destination chain tokens are mapped
    event TokenMappingUpdated(uint256 dstChainId, address dstToken, address srcToken);

    /// @notice Emitted when swap fees have been withdrawn to a recipient address
    event SwapFeesWithdrawn(address indexed token, address indexed recipient, uint256 amount);

    // -------- Core Transfer Logic --------

    function requestCrossChainSwap(address token, uint256 amount, uint256 fee, uint256 dstChainId, address recipient)
        external
        returns (bytes32 requestId);

    function updateFeesIfUnfulfilled(bytes32 requestId, uint256 newFee) external;

    function rebalanceSolver(address solver, bytes32 requestId, bytes calldata signature) external;

    /// @notice Relays tokens to the recipient and stores a receipt
    /// @param token The token being relayed
    /// @param recipient The target recipient of the tokens
    /// @param amount The net amount delivered (after fees)
    /// @param requestId The original request ID from the source chain
    /// @param srcChainId The ID of the source chain where the request originated
    function relayTokens(address token, address recipient, uint256 amount, bytes32 requestId, uint256 srcChainId)
        external;

    // -------- View Functions --------

    function getSwapFeeAmount(uint256 amount) external view returns (uint256);
    function getRequestId(TransferParams memory p) external view returns (bytes32);
    function getChainID() external view returns (uint256);
    function getBlsValidator() external view returns (address);
    function getSwapFeeBps() external view returns (uint256);
    function getThisChainId() external view returns (uint256);
    function getTotalSwapFeesBalance(address token) external view returns (uint256);
    function getAllowedDstChainId(uint256 chainId) external view returns (bool);
    function getTokenMapping(address srcToken, uint256 dstChainId) external view returns (address);
    function getTransferParameters(bytes32 requestId) external view returns (TransferParams memory transferParams);
    function getFulfilledTransfers() external view returns (bytes32[] memory);
    function getUnfulfilledSolverRefunds() external view returns (bytes32[] memory);
    function getFulfilledSolverRefunds() external view returns (bytes32[] memory);
    function getReceipt(bytes32 _requestId)
        external
        view
        returns (
            bytes32 requestId,
            uint256 srcChainId,
            address token,
            bool fulfilled,
            address solver,
            address recipient,
            uint256 amount,
            uint256 fulfilledAt
        );

    // -------- Admin Functions --------

    function setSwapFeeBps(uint256 _swapFeeBps) external;
    function setBlsValidator(address _blsValidator) external;
    function permitDestinationChainId(uint256 chainId) external;
    function blockDestinationChainId(uint256 chainId) external;
    function setTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external;
    function withdrawSwapFees(address token, address to) external;
}
