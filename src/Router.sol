// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {BLS} from "./libraries/BLS.sol";
import {ISignatureScheme} from "./interfaces/ISignatureScheme.sol";

import {IRouter} from "./interfaces/IRouter.sol";

/// @title Cross-Chain Token Router
/// @notice Handles token bridging logic, fee distribution, and transfer request verification using BLS signatures
/// @dev Integrates with off-chain solvers and a destination Bridge contract
contract Router is Ownable, IRouter {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice Basis points divisor
    uint256 public constant BPS_DIVISOR = 10_000;

    /// @notice Max total fee in BPS (50%)
    uint256 public constant MAX_FEE_BPS = 5_000;
    uint256 public bridgeFeeBps = 500;

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
    /// @return requestId The unique bridge request id
    function bridge(address token, uint256 amount, uint256 fee, uint256 dstChainId, address recipient, uint256 nonce)
        external
        returns (bytes32 requestId)
    {
        require(amount > 0, "Zero amount");
        require(tokenMappings[token][dstChainId] != address(0), "Token not supported");

        uint256 bridgeFeeAmount = getBridgeFeeAmount(fee);
        uint256 solverFee = fee - bridgeFeeAmount;

        totalBridgeFeesBalance[token] += bridgeFeeAmount;

        TransferParams memory params =
            buildTransferParams(token, amount, bridgeFeeAmount, solverFee, dstChainId, recipient, nonce);

        (bytes memory message,,) = transferParamsToBytes(params);
        requestId = getRequestId(params);

        storeTransferRequest(requestId, params);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount + fee);

        emit MessageEmitted(requestId, message);
    }

    function updateFeesIfUnfulfilled(bytes32 requestId, uint256 newFee) external {
        TransferParams storage params = transferParameters[requestId];
        require(!params.executed, "Request already fulfilled");
        require(params.sender == msg.sender, "Unauthorised caller");

        // Calculate new bridge fee and solver fee from newFee
        uint256 newBridgeFeeAmount = getBridgeFeeAmount(newFee);
        uint256 newSolverFee = newFee - newBridgeFeeAmount;

        // Adjust the totalBridgeFeesBalance for the token
        // Subtract old bridge fee, add new bridge fee
        totalBridgeFeesBalance[params.token] =
            totalBridgeFeesBalance[params.token] - params.bridgeFee + newBridgeFeeAmount;

        // Update the fees in the stored params
        params.bridgeFee = newBridgeFeeAmount;
        params.solverFee = newSolverFee;

        // Emit event if needed for tracking fee updates (optional)
        emit BridgeRequestFeeUpdated(requestId, params.token, newBridgeFeeAmount, newSolverFee);
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
    function getBridgeFeeAmount(uint256 amount) public view returns (uint256) {
        if (bridgeFeeBps == 0) return 0;
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

    function getBridgeFeeBps() external view returns (uint256) {
        return bridgeFeeBps;
    }

    function getThisChainId() external view returns (uint256) {
        return thisChainId;
    }

    function getBlsValidator() external view returns (address) {
        return address(blsValidator);
    }

    function getTransferParameters(bytes32 requestId) external view returns (TransferParams memory transferParams) {
        transferParams = transferParameters[requestId];
    }

    function getAllowedDstChainId(uint256 chainId) external view returns (bool) {
        return allowedDstChainIds[chainId];
    }

    function getTokenMapping(address srcToken, uint256 dstChainId) external view returns (address) {
        return tokenMappings[srcToken][dstChainId];
    }

    function getTotalBridgeFeesBalance(address token) external view returns (uint256) {
        return totalBridgeFeesBalance[token];
    }

    function getExecutedMessageStatus(bytes calldata message) external view returns (bool) {
        return executedMessages[message];
    }

    function getUnfulfilledRequestIds() external view returns (bytes32[] memory) {
        return unfulfilledRequestIds.values();
    }

    function getFulfilledRequestIds() external view returns (bytes32[] memory) {
        return fulfilledRequestIds.values();
    }

    // ---------------------- Admin Functions ----------------------

    /// @notice Sets the bridge fee in BPS
    /// @param _bridgeFeeBps New bridge fee
    function setBridgeFeeBps(uint256 _bridgeFeeBps) external onlyOwner {
        require(_bridgeFeeBps <= MAX_FEE_BPS, "Too high");
        bridgeFeeBps = _bridgeFeeBps;
        emit BridgeFeeBpsUpdated(bridgeFeeBps);
    }

    /// @notice Updates the BLS signature validator
    /// @param _blsValidator New validator address
    function setBlsValidator(address _blsValidator) external onlyOwner {
        blsValidator = ISignatureScheme(_blsValidator);
        emit BLSValidatorUpdated(address(blsValidator));
    }

    /// @notice Allows or disallows a destination chain ID
    /// @param chainId Chain ID to toggle
    /// @param allowed Whether it is allowed
    function allowDstChainId(uint256 chainId, bool allowed) external onlyOwner {
        allowedDstChainIds[chainId] = allowed;
        emit WhitelistUpdatedForDSTChainId(chainId, allowed);
    }

    /// @notice Sets a token mapping for a cross-chain pair
    /// @param dstChainId Destination chain ID
    /// @param dstToken Token address on the destination chain
    /// @param srcToken Token address on the source chain
    function setTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external onlyOwner {
        require(allowedDstChainIds[dstChainId], "Destination chain id not supported");
        tokenMappings[srcToken][dstChainId] = dstToken;
        emit TokenMappingUpdated(dstChainId, dstToken, srcToken);
    }

    /// @notice Withdraws accumulated bridge fees
    /// @param token Token address to withdraw
    /// @param to Recipient address
    function withdrawBridgeFees(address token, address to) external onlyOwner {
        uint256 amount = totalBridgeFeesBalance[token];
        totalBridgeFeesBalance[token] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit BridgeFeesWithdrawn(token, to, amount)
    }
}
