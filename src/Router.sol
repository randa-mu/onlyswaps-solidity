// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {BLS} from "./libraries/BLS.sol";
import {ISignatureScheme} from "./interfaces/ISignatureScheme.sol";

/// @title Cross-Chain Token Router
/// @notice Handles token bridging logic, fee distribution, and transfer request verification using BLS signatures
/// @dev Integrates with off-chain solvers and a destination Bridge contract
contract Router is Ownable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice Transfer parameters for each bridge request
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

    /// @notice Basis points divisor
    uint256 public constant BPS_DIVISOR = 10_000;

    /// @notice Max total fee in BPS (50%)
    uint256 public constant MAX_FEE_BPS = 5_000;

    /// @notice Bridge fee in BPS (applied to total amount)
    uint256 public bridgeFeeBps = 500;

    /// @notice Solver fee in BPS (applied to bridge fee)
    uint256 public solverFeeBps = 500;

    /// @notice Current chain ID (immutable)
    uint256 public immutable thisChainId;

    /// @notice BLS validator used for signature verification
    ISignatureScheme public blsValidator;

    /// @dev Stores all unfulfilled transfer request IDs
    EnumerableSet.Bytes32Set private unfulfilledRequestIds;

    /// @dev Stores all fulfilled transfer request IDs
    EnumerableSet.Bytes32Set private fulfilledRequestIds;

    /// @notice Mapping of requestId => transfer parameters
    mapping(bytes32 => TransferParams) public transferParameters;

    /// @notice Tracks executed BLS messages to prevent replay
    mapping(bytes => bool) public executedMessages;

    /// @notice Whitelisted destination chain IDs
    mapping(uint256 => bool) public allowedDstChainIds;

    /// @notice Mapping of srcToken => dstChainId => dstToken
    mapping(address => mapping(uint256 => address)) public tokenMappings;

    /// @notice Accumulated fees per token
    mapping(address => uint256) public totalBridgeFeesBalance;

    /// @notice Emitted when a new message (request) is created
    /// @param requestId Hash of transfer parameters
    /// @param message Encoded payload for off-chain solver
    event MessageEmitted(bytes32 indexed requestId, bytes message);

    /// @notice Emitted when a message is successfully fulfilled by a solver
    /// @param requestId Hash of the transfer parameters
    /// @param message Encoded fulfilled payload
    event MessageExecuted(bytes32 requestId, bytes message);

    /// @notice Emitted when tokens are recovered from contract
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);

    /// @param _owner Initial contract owner
    /// @param _blsValidator BLS validator address
    constructor(address _owner, address _blsValidator) Ownable(_owner) {
        blsValidator = ISignatureScheme(_blsValidator);
        thisChainId = getChainID();
    }

    // ---------------------- Core Transfer Logic ----------------------

    /// @notice Initiates a bridge request
    /// @param token Address of the ERC20 token to bridge
    /// @param amount Amount of tokens to bridge
    /// @param dstChainId Target chain ID
    /// @param recipient Address to receive bridged tokens on target chain
    /// @param nonce Unique user-provided nonce
    function bridge(address token, uint256 amount, uint256 dstChainId, address recipient, uint256 nonce) external {
        require(amount > 0, "Zero amount");
        require(tokenMappings[token][dstChainId] != address(0), "Token not supported");

        uint256 bridgeFeeAmount = getBridgeFeeAmountInUnderlying(amount);
        uint256 solverFee = (bridgeFeeAmount * solverFeeBps) / BPS_DIVISOR;
        uint256 remainingFee = bridgeFeeAmount - solverFee;

        totalBridgeFeesBalance[token] += remainingFee;

        TransferParams memory params =
            buildTransferParams(token, amount, bridgeFeeAmount, solverFee, dstChainId, recipient, nonce);

        (bytes memory message,,) = transferParamsToBytes(params);
        bytes32 requestId = getRequestId(params);

        storeTransferRequest(requestId, params);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit MessageEmitted(requestId, message);
    }

    /// @notice Called by owner to approve a solver’s fulfillment of a bridge request
    /// @param solver Address of the solver being paid
    /// @param requestId Unique ID of the request
    /// @param message Original message data
    /// @param signature BLS signature of the message
    function rebalanceSolver(address solver, bytes32 requestId, bytes calldata message, bytes calldata signature)
        external
        onlyOwner
    {
        TransferParams storage params = transferParameters[requestId];
        require(!params.executed, "Message already executed");
        require(params.dstChainId == thisChainId, "Invalid dstChainId");

        TransferParams memory decoded = abi.decode(message, (TransferParams));
        require(isEqual(params, decoded), "Non-equal transfer parameters");

        (, bytes memory messageAsG1Bytes,) = transferParamsToBytes(params);
        require(
            blsValidator.verifySignature(messageAsG1Bytes, signature, blsValidator.getPublicKeyBytes()),
            "Invalid BLS signature"
        );

        fulfilledRequestIds.add(requestId);
        unfulfilledRequestIds.remove(requestId);
        params.executed = true;

        uint256 bridgedAmount = params.amount - params.bridgeFee;
        uint256 solverRefund = bridgedAmount + params.solverFee;

        IERC20(params.token).safeTransfer(solver, solverRefund);

        emit MessageExecuted(requestId, message);
    }

    // ---------------------- Utility & View ----------------------

    /// @notice Converts transfer params to message and BLS format
    function transferParamsToBytes(TransferParams memory params)
        public
        view
        returns (bytes memory message, bytes memory messageAsG1Bytes, BLS.PointG1 memory messageAsG1Point)
    {
        message = abi.encode(
            params.sender,
            params.recipient,
            params.token,
            params.amount,
            params.srcChainId,
            params.dstChainId,
            params.bridgeFee,
            params.solverFee,
            params.nonce,
            params.executed
        );
        (uint256 x, uint256 y) = blsValidator.hashToPoint(message);
        messageAsG1Point = BLS.PointG1({x: x, y: y});
        messageAsG1Bytes = blsValidator.hashToBytes(message);
    }

    /// @notice Builds a new transfer parameter object
    function buildTransferParams(
        address token,
        uint256 amount,
        uint256 bridgeFeeAmount,
        uint256 solverFeeAmount,
        uint256 dstChainId,
        address recipient,
        uint256 nonce
    ) public view returns (TransferParams memory params) {
        params = TransferParams({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            amount: amount,
            srcChainId: thisChainId,
            dstChainId: dstChainId,
            bridgeFee: bridgeFeeAmount,
            solverFee: solverFeeAmount,
            nonce: nonce,
            executed: false
        });
    }

    /// @notice Stores a transfer request and marks as unfulfilled
    function storeTransferRequest(bytes32 requestId, TransferParams memory params) internal {
        transferParameters[requestId] = params;
        unfulfilledRequestIds.add(requestId);
    }

    /// @notice Compares two transfer parameter structs
    function isEqual(TransferParams memory a, TransferParams memory b) internal pure returns (bool) {
        return a.sender == b.sender && a.recipient == b.recipient && a.token == b.token && a.amount == b.amount
            && a.srcChainId == b.srcChainId && a.dstChainId == b.dstChainId && a.bridgeFee == b.bridgeFee
            && a.solverFee == b.solverFee && a.nonce == b.nonce && a.executed == b.executed;
    }

    /// @notice Computes the bridge fee in underlying token units
    function getBridgeFeeAmountInUnderlying(uint256 amount) public view returns (uint256) {
        return (amount * bridgeFeeBps) / BPS_DIVISOR;
    }

    /// @notice Computes the unique request ID (hash of transfer parameters)
    function getRequestId(TransferParams memory p) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                p.sender,
                p.recipient,
                p.token,
                p.amount,
                getChainID(),
                p.dstChainId,
                p.bridgeFee,
                p.solverFee,
                p.nonce,
                p.executed
            )
        );
    }

    /// @notice Returns the current EVM chain ID
    function getChainID() public view returns (uint256) {
        return block.chainid;
    }

    /// @notice Returns list of all fulfilled request IDs
    function getAllFulfilledRequestIds() external view returns (bytes32[] memory) {
        return fulfilledRequestIds.values();
    }

    /// @notice Returns list of all unfulfilled request IDs
    function getAllUnfulfilledRequestIds() external view returns (bytes32[] memory) {
        return unfulfilledRequestIds.values();
    }

    // ---------------------- Admin Functions ----------------------

    /// @notice Sets the solver fee in BPS
    /// @param _solverFeeBps New solver fee
    function setSolverFeeBps(uint256 _solverFeeBps) external onlyOwner {
        require(_solverFeeBps <= MAX_FEE_BPS, "Too high");
        solverFeeBps = _solverFeeBps;
    }

    /// @notice Sets the bridge fee in BPS
    /// @param _bridgeFeeBps New bridge fee
    function setBridgeFeeBps(uint256 _bridgeFeeBps) external onlyOwner {
        require(_bridgeFeeBps <= MAX_FEE_BPS, "Too high");
        bridgeFeeBps = _bridgeFeeBps;
    }

    /// @notice Updates the BLS signature validator
    /// @param _blsValidator New validator address
    function setBlsValidator(address _blsValidator) external onlyOwner {
        blsValidator = ISignatureScheme(_blsValidator);
    }

    /// @notice Allows or disallows a destination chain ID
    /// @param chainId Chain ID to toggle
    /// @param allowed Whether it is allowed
    function allowDstChainId(uint256 chainId, bool allowed) external onlyOwner {
        allowedDstChainIds[chainId] = allowed;
    }

    /// @notice Sets a token mapping for a cross-chain pair
    /// @param dstChainId Destination chain ID
    /// @param dstToken Token address on the destination chain
    /// @param srcToken Token address on the source chain
    function setTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external onlyOwner {
        require(allowedDstChainIds[dstChainId], "Destination chain id not supported");
        tokenMappings[srcToken][dstChainId] = dstToken;
    }

    /// @notice Withdraws accumulated bridge fees
    /// @param token Token address to withdraw
    /// @param to Recipient address
    function withdrawBridgeFees(address token, address to) external onlyOwner {
        uint256 amount = totalBridgeFeesBalance[token];
        totalBridgeFeesBalance[token] = 0;
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Rescues tokens sent to the contract by mistake
    /// @param token Token to rescue
    /// @param to Recipient of the rescued tokens
    /// @param amount Amount to rescue
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(to != address(0), "Invalid recipient");

        // todo: ensure token is not supported
        IERC20(token).safeTransfer(to, amount);
    }
}
