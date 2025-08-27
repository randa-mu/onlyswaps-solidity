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

    function getVerificationFeeAmount(uint256 totalFees) external view returns (uint256);
    function getRequestId(SwapRequestParameters memory p) external view returns (bytes32);
    function getChainID() external view returns (uint256);
    function getBlsValidator() external view returns (address);
    function getVerificationFeeBps() external view returns (uint256);
    function getTotalVerificationFeeBalance(address token) external view returns (uint256);
    function getAllowedDstChainId(uint256 chainId) external view returns (bool);
    function getTokenMapping(address srcToken, uint256 dstChainId) external view returns (address);
    function getSwapRequestParameters(bytes32 requestId)
        external
        view
        returns (SwapRequestParameters memory transferParams);
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
    function buildSwapRequestParameters(
        address token,
        uint256 amount,
        uint256 verificationFeeAmount,
        uint256 solverFeeAmount,
        uint256 dstChainId,
        address recipient,
        uint256 nonce
    ) external view returns (SwapRequestParameters memory params);

    function swapRequestParametersToBytes(bytes32 requestId)
        external
        view
        returns (bytes memory message, bytes memory messageAsG1Bytes, BLS.PointG1 memory messageAsG1Point);

    // -------- Admin Functions --------

    function setVerificationFeeBps(uint256 _verificationFeeBps) external;
    function setBlsValidator(address _blsValidator) external;
    function permitDestinationChainId(uint256 chainId) external;
    function blockDestinationChainId(uint256 chainId) external;
    function setTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external;
    function withdrawVerificationFee(address token, address to) external;
}
