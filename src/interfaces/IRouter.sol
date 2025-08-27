// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {BLS} from "../libraries/BLS.sol";

interface IRouter {
    // -------- Structs --------

    struct SwapRequestParameters {
        address sender; // Address initiating the swap on the source chain
        address recipient; // Address to receive tokens on the destination chain
        address token; // Token address being transferred
        uint256 amount; // Amount to be received by the recipient on the destination chain
        uint256 srcChainId; // Source chain ID where the request originated
        uint256 dstChainId; // Destination chain ID where tokens will be delivered
        uint256 verificationFee; // Total swap fee deducted from the amount
        uint256 solverFee; // Portion of verificationFee paid to the solver
        uint256 nonce; // Unique nonce to prevent replay attacks
        bool executed; // Whether the transfer has been executed
    }

    /// @notice Structure to store details of a fulfilled transfer request
    struct SwapRequestReceipt {
        bytes32 requestId; // Reference to the original request on the source chain
        uint256 srcChainId; // Source chain ID from which the request originated
        uint256 dstChainId; // Destination chain ID where the request was fulfilled
        address token; // Token being transferred
        bool fulfilled; // Whether the transfer has been delivered
        address solver; // Address that fulfilled the request
        address recipient; // Recipient of the tokens on the destination chain
        uint256 amount; // Amount delivered to the recipient (after fees)
        uint256 fulfilledAt; // Timestamp when the request was fulfilled
    }

    // -------- Events --------

    /// @notice Emitted when a new swap request is created
    /// @param requestId Hash of the transfer parameters
    /// @param srcChainId The source chain ID from which the request originated
    /// @param dstChainId The destination chain ID where the tokens will be delivered
    /// @param token The address of the token being transferred
    /// @param sender The address initiating the swap
    /// @param recipient The address that will receive the tokens on the destination chain
    /// @param amount The amount of tokens requested for transfer
    /// @param fee The fee associated with the swap request
    /// @param nonce A unique identifier to prevent replay attacks
    /// @param requestedAt The timestamp when the swap request was created
    event SwapRequested(
        bytes32 indexed requestId,
        uint256 indexed srcChainId,
        uint256 indexed dstChainId,
        address token,
        address sender,
        address recipient,
        uint256 amount,
        uint256 fee,
        uint256 nonce,
        uint256 requestedAt
    );

    /// @notice Emitted when a swap request is fulfilled on the destination chain by a solver
    /// @param requestId The unique ID of the swap request
    /// @param srcChainId The source chain ID from which the request originated
    /// @param dstChainId The destination chain ID where the tokens were delivered
    /// @param token The address of the token that was transferred
    /// @param solver The address that fulfilled the transfer
    /// @param recipient The address that received the tokens on the destination chain
    /// @param amount The amount transferred to the recipient
    /// @param fulfilledAt The timestamp when the transfer was fulfilled
    event SwapRequestFulfilled(
        bytes32 indexed requestId,
        uint256 indexed srcChainId,
        uint256 indexed dstChainId,
        address token,
        address solver,
        address recipient,
        uint256 amount,
        uint256 fulfilledAt
    );

    /// @notice Emitted when a message is successfully fulfilled by a solver
    /// @param requestId Hash of the transfer parameters
    event SolverPayoutFulfilled(bytes32 indexed requestId);

    /// @notice Emitted when the fee is updated for a request by the sender
    /// @param requestId Hash of the transfer parameters
    event SwapRequestFeeUpdated(bytes32 indexed requestId);

    /// @notice Emitted when the swap fee Bps is updated
    /// @param newFeeBps The new fee in basis points
    event VerificationFeeBpsUpdated(uint256 newFeeBps);

    /// @notice Emitted when the bls validator contract is updated
    /// @param blsValidator The new BLS validator contract address
    event BLSValidatorUpdated(address indexed blsValidator);

    /// @notice Emitted when the destination chain id is permitted
    /// @param chainId The permitted chain id
    event DestinationChainIdPermitted(uint256 chainId);

    /// @notice Emitted when the destination chain id is blocked
    /// @param chainId The blocked chain id
    event DestinationChainIdBlocked(uint256 chainId);

    /// @notice Emitted when a pair of source and destination chain tokens are mapped
    /// @param dstChainId The destination chain id
    /// @param dstToken The destination token address
    /// @param srcToken The source token address
    event TokenMappingUpdated(uint256 dstChainId, address dstToken, address srcToken);

    /// @notice Emitted when swap fees have been withdrawn to a recipient address
    /// @param token The token address of the withdrawn fees
    /// @param recipient The address receiving the withdrawn fees
    /// @param amount The amount of fees withdrawn
    event VerificationFeeWithdrawn(address indexed token, address indexed recipient, uint256 amount);

    // -------- Core Transfer Logic --------

    /// @notice Initiates a cross-chain swap request
    /// @param token The address of the token to be swapped
    /// @param amount The amount of tokens to be swapped
    /// @param fee The fee associated with the swap request
    /// @param dstChainId The destination chain ID where the tokens will be sent
    /// @param recipient The address that will receive the tokens on the destination chain
    /// @return requestId The unique ID of the created swap request
    function requestCrossChainSwap(address token, uint256 amount, uint256 fee, uint256 dstChainId, address recipient)
        external
        returns (bytes32 requestId);

    /// @notice Updates the fee for an unfulfilled swap request
    /// @param requestId The unique ID of the swap request to update
    /// @param newFee The new fee to be set for the swap request
    function updateFeesIfUnfulfilled(bytes32 requestId, uint256 newFee) external;

    /// @notice Called with a BLS signature to approve a solver’s fulfillment of a swap request.
    /// @notice The solver is sent the amount transferred to the recipient wallet on the destination chain
    ///         plus the solver fee.
    /// @param solver The address of the solver being compensated for their service.
    /// @param requestId The unique ID of the swap request being fulfilled.
    /// @param signature The BLS signature verifying the authenticity of the request.
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

    /// @notice Calculates the verification fee amount based on total fees
    /// @param totalFees The total fees for which the verification fee is to be calculated
    /// @return The calculated verification fee amount
    function getVerificationFeeAmount(uint256 totalFees) external view returns (uint256);

    /// @notice Generates a unique request ID based on the provided swap request parameters
    /// @param p The swap request parameters
    /// @return The generated request ID
    function getRequestId(SwapRequestParameters memory p) external view returns (bytes32);

    /// @notice Retrieves the current chain ID
    /// @return The current chain ID
    function getChainID() external view returns (uint256);

    /// @notice Retrieves the address of the BLS validator
    /// @return The address of the BLS validator
    function getBlsValidator() external view returns (address);

    /// @notice Retrieves the current verification fee in basis points
    /// @return The current verification fee in basis points
    function getVerificationFeeBps() external view returns (uint256);

    /// @notice Retrieves the total verification fee balance for a specific token
    /// @param token The address of the token
    /// @return The total verification fee balance for the specified token
    function getTotalVerificationFeeBalance(address token) external view returns (uint256);

    /// @notice Checks if a destination chain ID is allowed
    /// @param chainId The chain ID to check
    /// @return True if the chain ID is allowed, false otherwise
    function getAllowedDstChainId(uint256 chainId) external view returns (bool);

    /// @notice Retrieves the token mapping for a given source token and destination chain ID
    /// @param srcToken The address of the source token
    /// @param dstChainId The destination chain ID
    /// @return The address of the mapped destination token
    function getTokenMapping(address srcToken, uint256 dstChainId) external view returns (address);

    /// @notice Retrieves the swap request parameters for a given request ID
    /// @param requestId The unique ID of the swap request
    /// @return swapRequestParams The swap request parameters associated with the request ID
    function getSwapRequestParameters(bytes32 requestId)
        external
        view
        returns (SwapRequestParameters memory swapRequestParams);

    /// @notice Returns an array of swap request IDs where the tokens have been
    ///         transferred to the recipient address on the destination chain
    /// @return An array of bytes32 representing the request IDs
    function getFulfilledTransfers() external view returns (bytes32[] memory);

    /// @notice Returns an array of request IDs with unfulfilled solver refunds
    /// @return An array of bytes32 representing the request IDs
    function getUnfulfilledSolverRefunds() external view returns (bytes32[] memory);

    /// @notice Returns an array of request IDs with fulfilled solver refunds
    /// @return An array of bytes32 representing the request IDs
    function getFulfilledSolverRefunds() external view returns (bytes32[] memory);

    /// @notice Retrieves the receipt for a specific request ID
    /// @param requestId The request ID to check
    /// @return requestId The unique ID of the transfer request
    /// @return srcChainId The source chain ID from which the request originated
    /// @return dstChainId The destination chain ID where the tokens were delivered
    /// @return token The address of the token involved in the transfer
    /// @return fulfilled Indicates if the transfer was fulfilled
    /// @return solver The address of the solver who fulfilled the transfer
    /// @return recipient The address that received the tokens on the destination chain
    /// @return amount The amount of tokens transferred to the recipient
    /// @return fulfilledAt The timestamp when the transfer was fulfilled
    function getReceipt(bytes32 _requestId)
        external
        view
        returns (
            bytes32 requestId,
            uint256 srcChainId,
            uint256 dstChainId,
            address token,
            bool fulfilled,
            address solver,
            address recipient,
            uint256 amount,
            uint256 fulfilledAt
        );

    /// @notice Builds swap request parameters based on the provided details
    /// @param token The address of the token to be swapped
    /// @param amount The amount of tokens to be swapped
    /// @param verificationFeeAmount The verification fee amount
    /// @param solverFeeAmount The solver fee amount
    /// @param dstChainId The destination chain ID
    /// @param recipient The address that will receive the tokens
    /// @param nonce A unique nonce for the request
    /// @return swapRequestParams A SwapRequestParameters struct containing the transfer parameters.
    function buildSwapRequestParameters(
        address token,
        uint256 amount,
        uint256 verificationFeeAmount,
        uint256 solverFeeAmount,
        uint256 dstChainId,
        address recipient,
        uint256 nonce
    ) external view returns (SwapRequestParameters memory swapRequestParams);

    /// @notice Converts swap request parameters to a message as bytes and BLS format for signing
    /// @param requestId The unique request ID
    /// @return message The encoded message bytes
    /// @return messageAsG1Bytes The message hashed to BLS G1 bytes
    /// @return messageAsG1Point The message hashed to BLS G1 point
    function swapRequestParametersToBytes(bytes32 requestId)
        external
        view
        returns (bytes memory message, bytes memory messageAsG1Bytes, BLS.PointG1 memory messageAsG1Point);

    // -------- Admin Functions --------

    /// @notice Sets the verification fee in basis points
    /// @param _verificationFeeBps The new verification fee in basis points
    function setVerificationFeeBps(uint256 _verificationFeeBps) external;

    /// @notice Updates the address of the BLS validator contract
    /// @param _blsValidator The new BLS validator contract address
    function setBlsValidator(address _blsValidator) external;

    /// @notice Permits a destination chain ID for swaps
    /// @param chainId The chain ID to be permitted
    function permitDestinationChainId(uint256 chainId) external;

    /// @notice Blocks a destination chain ID from being used for swaps
    /// @param chainId The chain ID to be blocked
    function blockDestinationChainId(uint256 chainId) external;

    /// @notice Sets the token mapping for a specific destination chain
    /// @param dstChainId The destination chain ID
    /// @param dstToken The address of the destination token
    /// @param srcToken The address of the source token
    function setTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external;

    /// @notice Withdraws verification fees to a specified address
    /// @param token The token address of the withdrawn fees
    /// @param to The address receiving the withdrawn fees
    function withdrawVerificationFee(address token, address to) external;
}
