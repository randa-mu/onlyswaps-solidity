// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IRouter {
    // -------- Structs --------

    struct TransferParams {
        address sender;
        address recipient;
        address token;
        uint256 amount; // user receives amount minus bridgeFee
        uint256 srcChainId;
        uint256 dstChainId;
        uint256 bridgeFee; // deducted from amount
        uint256 solverFee; // deducted from bridge fee
        uint256 nonce;
        bool executed;
    }

    // -------- Events --------

    /// @notice Emitted when a new message (request) is created
    /// @param requestId Hash of transfer parameters
    /// @param message Encoded payload for off-chain solver
    event MessageEmitted(bytes32 indexed requestId, bytes message);

    /// @notice Emitted when a message is successfully fulfilled by a solver
    /// @param requestId Hash of the transfer parameters
    /// @param message Encoded fulfilled payload
    event MessageExecuted(bytes32 indexed requestId, bytes message);

    /// @notice Emitted when tokens are recovered from contract
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted when the fee is updated for a request by the sender
    event FeesUpdated(bytes32 indexed requestId, address token, uint256 newBridgeFee, uint256 newSolverFee);

    // -------- Core Transfer Logic --------

    function bridge(address token, uint256 amount, uint256 fee, uint256 dstChainId, address recipient, uint256 nonce)
        external
        returns (bytes32 requestId);

    function updateFeesIfUnfulfilled(bytes32 requestId, uint256 newFee) external;

    function rebalanceSolver(address solver, bytes32 requestId, bytes calldata message, bytes calldata signature)
        external;

    // -------- View Functions --------

    function getAllFulfilledRequestIds() external view returns (bytes32[] memory);
    function getAllUnfulfilledRequestIds() external view returns (bytes32[] memory);
    function getBridgeFeeAmount(uint256 amount) external view returns (uint256);
    function getRequestId(TransferParams memory p) external view returns (bytes32);
    function getChainID() external view returns (uint256);
    function getBlsValidator() external view returns (address);
    function getBridgeFeeBps() external view returns (uint256);
    function getThisChainId() external view returns (uint256);
    function getTotalBridgeFeesBalance(address token) external view returns (uint256);
    function getAllowedDstChainId(uint256 chainId) external view returns (bool);
    function getTokenMapping(address srcToken, uint256 dstChainId) external view returns (address);
    function getTransferParameters(bytes32 requestId) external view returns (TransferParams memory transferParams);
    function getExecutedMessageStatus(bytes calldata message) external view returns (bool);
    function getUnfulfilledRequestIds() external view returns (bytes32[] memory);
    function getFulfilledRequestIds() external view returns (bytes32[] memory);

    // -------- Admin Functions --------

    function setBridgeFeeBps(uint256 _bridgeFeeBps) external;
    function setBlsValidator(address _blsValidator) external;
    function allowDstChainId(uint256 chainId, bool allowed) external;
    function setTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external;
    function withdrawBridgeFees(address token, address to) external;
    function rescueERC20(address token, address to, uint256 amount) external;
}
