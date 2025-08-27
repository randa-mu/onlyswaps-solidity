// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {ErrorsLib} from "./libraries/ErrorsLib.sol";

import {ISignatureScheme} from "./interfaces/ISignatureScheme.sol";
import {IRouter, BLS} from "./interfaces/IRouter.sol";

/// @title Router Contract for Cross-Chain Token Swaps
/// @notice This contract facilitates cross-chain token swaps with fee management and BLS signature verification.
contract Router is Ownable, ReentrancyGuard, IRouter {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice Basis points divisor
    uint256 public constant BPS_DIVISOR = 10_000;

    /// @notice Max total fee in BPS (50%)
    uint256 public constant MAX_FEE_BPS = 5_000;
    uint256 public verificationFeeBps = 500;

    /// @notice BLS validator used for signature verification
    ISignatureScheme public blsValidator;

    /// @dev Stores all fulfilled transfer request IDs
    EnumerableSet.Bytes32Set private fulfilledTransfers;

    /// @dev Stores all unfulfilled solver refunds by request IDs
    EnumerableSet.Bytes32Set private unfulfilledSolverRefunds;

    /// @dev Stores all fulfilled solver refunds by request IDs
    EnumerableSet.Bytes32Set private fulfilledSolverRefunds;

    /// @notice Mapping of requestId => swap request parameters
    mapping(bytes32 => SwapRequestParameters) public swapRequestParameters;

    /// @notice Whitelisted destination chain IDs
    mapping(uint256 => bool) public allowedDstChainIds;

    /// @notice Mapping of srcToken => dstChainId => dstToken
    mapping(address => mapping(uint256 => address)) public tokenMappings;

    /// @notice Accumulated fees per token
    mapping(address => uint256) public totalVerificationFeeBalance;

    /// @notice Unique nonce for each swap request and user
    uint256 public currentNonce;

    /// @dev Mapping of nonce to requester address
    mapping(uint256 => address) public nonceToRequester;

    /// @dev Mapping of requestId to transfer receipt
    mapping(bytes32 => SwapRequestReceipt) public swapRequestReceipts;

    /// @param _owner Initial contract owner
    /// @param _blsValidator BLS validator address
    constructor(address _owner, address _blsValidator) Ownable(_owner) {
        blsValidator = ISignatureScheme(_blsValidator);
    }

    // ---------------------- Core Transfer Logic ----------------------

    /// @notice Initiates a swap request
    /// @param token Address of the ERC20 token to swap
    /// @param amount Amount of tokens to swap
    /// @param fee Total fee amount (in token units) to be paid by the user
    /// @param dstChainId Target chain ID
    /// @param recipient Address to receive swaped tokens on target chain
    /// @return requestId The unique swap request id
    function requestCrossChainSwap(address token, uint256 amount, uint256 fee, uint256 dstChainId, address recipient)
        external
        nonReentrant
        returns (bytes32 requestId)
    {
        require(amount > 0, ErrorsLib.ZeroAmount());
        require(tokenMappings[token][dstChainId] != address(0), ErrorsLib.TokenNotSupported());

        // Calculate the swap fee amount (for the protocol) to be deducted from the total fee
        // based on the total fee provided
        uint256 verificationFeeAmount = getVerificationFeeAmount(fee);
        // Calculate the solver fee by subtracting the swap fee from the total fee
        // The solver fee is the remaining portion of the fee
        // The total fee must be greater than the swap fee to ensure the solver is compensated
        require(fee > verificationFeeAmount, ErrorsLib.FeeTooLow());
        uint256 solverFee = fee - verificationFeeAmount;

        // Accumulate the total swap fees balance for the specified token
        totalVerificationFeeBalance[token] += verificationFeeAmount;

        // Generate unique nonce and map it to sender
        uint256 nonce = ++currentNonce;
        nonceToRequester[nonce] = msg.sender;

        SwapRequestParameters memory params =
            buildSwapRequestParameters(token, amount, verificationFeeAmount, solverFee, dstChainId, recipient, nonce);

        requestId = getRequestId(params);

        storeTransferRequest(requestId, params);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount + fee);

        emit SwapRequested(
            requestId, getChainID(), dstChainId, token, msg.sender, recipient, amount, fee, nonce, block.timestamp
        );
    }

    function updateFeesIfUnfulfilled(bytes32 requestId, uint256 newFee) external nonReentrant {
        SwapRequestParameters storage params = swapRequestParameters[requestId];
        require(!params.executed, ErrorsLib.AlreadyFulfilled());
        require(params.sender == msg.sender, ErrorsLib.UnauthorisedCaller());
        require(
            newFee > params.verificationFee + params.solverFee,
            ErrorsLib.NewFeeTooLow(newFee, params.verificationFee + params.solverFee)
        );

        IERC20(params.token).safeTransferFrom(
            msg.sender, address(this), newFee - (params.verificationFee + params.solverFee)
        );

        // Calculate new swap fee and solver fee from newFee
        uint256 newVerificationFeeAmount = getVerificationFeeAmount(newFee);
        uint256 newSolverFee = newFee - newVerificationFeeAmount;

        // Adjust the totalVerificationFeeBalance for the token
        // Subtract old swap fee, add new swap fee
        totalVerificationFeeBalance[params.token] =
            totalVerificationFeeBalance[params.token] - params.verificationFee + newVerificationFeeAmount;

        // Update the fees in the stored params
        params.verificationFee = newVerificationFeeAmount;
        params.solverFee = newSolverFee;

        // Emit event if needed for tracking fee updates (optional)
        emit SwapRequestFeeUpdated(requestId);
    }

    /// @notice Relays tokens to the recipient and stores a receipt
    /// @param token The token being relayed
    /// @param recipient The target recipient of the tokens
    /// @param amount The net amount delivered (after fees)
    /// @param requestId The original request ID from the source chain
    /// @param srcChainId The ID of the source chain where the request originated
    function relayTokens(address token, address recipient, uint256 amount, bytes32 requestId, uint256 srcChainId)
        external
        nonReentrant
    {
        require(!swapRequestReceipts[requestId].fulfilled, ErrorsLib.AlreadyFulfilled());
        require(token != address(0) && recipient != address(0), ErrorsLib.InvalidTokenOrRecipient());
        require(amount > 0, ErrorsLib.ZeroAmount());

        fulfilledTransfers.add(requestId);

        IERC20(token).safeTransferFrom(msg.sender, recipient, amount);

        swapRequestReceipts[requestId] = SwapRequestReceipt({
            requestId: requestId,
            srcChainId: srcChainId,
            dstChainId: getChainID(),
            token: token,
            fulfilled: true, // indicates the transfer was fulfilled, prevents double fulfillment
            solver: msg.sender,
            recipient: recipient,
            amount: amount,
            fulfilledAt: block.timestamp
        });

        emit SwapRequestFulfilled(
            requestId, srcChainId, getChainID(), token, msg.sender, recipient, amount, block.timestamp
        );
    }

    /// @notice Called with a BLS signature to approve a solver’s fulfillment of a swap request.
    /// @notice The solver is sent the amount transferred to the recipient wallet on the destination chain
    ///         plus the solver fee.
    /// @param solver The address of the solver being compensated for their service.
    /// @param requestId The unique ID of the swap request being fulfilled.
    /// @param signature The BLS signature verifying the authenticity of the request.
    function rebalanceSolver(address solver, bytes32 requestId, bytes calldata signature)
        external
        onlyOwner
        nonReentrant
    {
        SwapRequestParameters storage params = swapRequestParameters[requestId];
        require(!params.executed, ErrorsLib.AlreadyFulfilled());
        /// @dev rebalancing of solvers happens on the source chain router
        require(params.srcChainId == getChainID(), ErrorsLib.SourceChainIdMismatch(params.srcChainId, getChainID()));

        (, bytes memory messageAsG1Bytes,) = swapRequestParametersToBytes(requestId);
        require(
            blsValidator.verifySignature(messageAsG1Bytes, signature, blsValidator.getPublicKeyBytes()),
            ErrorsLib.BLSSignatureVerificationFailed()
        );

        fulfilledSolverRefunds.add(requestId);
        unfulfilledSolverRefunds.remove(requestId);
        params.executed = true;

        uint256 solverRefund = params.amount + params.solverFee;

        IERC20(params.token).safeTransfer(solver, solverRefund);

        emit SolverPayoutFulfilled(requestId);
    }

    // ---------------------- Utility & View ----------------------

    /// @notice Converts transfer params to message and BLS format
    /// @param requestId The unique request ID
    /// @return message The encoded message bytes
    /// @return messageAsG1Bytes The message hashed to BLS G1 bytes
    /// @return messageAsG1Point The message hashed to BLS G1 point
    function swapRequestParametersToBytes(bytes32 requestId)
        public
        view
        returns (bytes memory message, bytes memory messageAsG1Bytes, BLS.PointG1 memory messageAsG1Point)
    {
        SwapRequestParameters memory params = getSwapRequestParameters(requestId);
        /// @dev The order of parameters is critical for signature verification
        /// @dev The executed parameter is not used in the message hash
        message = abi.encode(
            params.sender,
            params.recipient,
            params.token,
            params.amount,
            params.srcChainId,
            params.dstChainId,
            params.nonce
        );
        (uint256 x, uint256 y) = blsValidator.hashToPoint(message);
        messageAsG1Point = BLS.PointG1({x: x, y: y});
        messageAsG1Bytes = blsValidator.hashToBytes(message);
    }

    /// @notice Builds a new transfer parameter object
    /// @param token The address of the token to be transferred.
    /// @param amount The amount of tokens to be transferred.
    /// @param verificationFeeAmount The fee amount for the swap.
    /// @param solverFeeAmount The fee amount for the solver.
    /// @param dstChainId The ID of the destination chain.
    /// @param recipient The address of the recipient of the transfer.
    /// @param nonce A unique identifier to prevent replay attacks.
    /// @return params A SwapRequestParameters struct containing the transfer parameters.
    function buildSwapRequestParameters(
        address token,
        uint256 amount,
        uint256 verificationFeeAmount,
        uint256 solverFeeAmount,
        uint256 dstChainId,
        address recipient,
        uint256 nonce
    ) public view returns (SwapRequestParameters memory params) {
        params = SwapRequestParameters({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            amount: amount,
            srcChainId: getChainID(),
            dstChainId: dstChainId,
            verificationFee: verificationFeeAmount,
            solverFee: solverFeeAmount,
            nonce: nonce,
            executed: false
        });
    }

    /// @notice Computes the swap fee in underlying token units
    /// @dev A percentage of the total fee set by the user is reserved as swap fee for the protocol
    /// @param totalFees The total fee amount in token units
    /// @return The calculated swap fee amount in token units
    function getVerificationFeeAmount(uint256 totalFees) public view returns (uint256) {
        if (verificationFeeBps == 0) return 0;
        return (totalFees * verificationFeeBps) / BPS_DIVISOR;
    }

    /// @notice Computes the unique request ID (hash of transfer parameters)
    /// @param p The transfer parameters used to compute the request ID
    /// @return requestId The unique request ID as a bytes32 hash
    function getRequestId(SwapRequestParameters memory p) public view returns (bytes32) {
        /// @dev The executed parameter is not used in the request ID hash as it is mutable
        return keccak256(
            abi.encode(
                p.sender,
                p.recipient,
                p.token,
                p.amount,
                getChainID(),
                p.dstChainId,
                p.verificationFee,
                p.solverFee,
                p.nonce
            )
        );
    }

    /// @notice Returns the current EVM chain ID
    /// @return The current chain ID as a uint256
    function getChainID() public view returns (uint256) {
        return block.chainid;
    }

    /// @notice Returns the swap fee in basis points
    /// @return The swap fee as a uint256
    function getVerificationFeeBps() external view returns (uint256) {
        return verificationFeeBps;
    }

    /// @notice Returns the address of the BLS validator
    /// @return The address of the BLS validator
    function getBlsValidator() external view returns (address) {
        return address(blsValidator);
    }

    /// @notice Returns the transfer parameters for a given request ID
    /// @param requestId The ID of the transfer request
    /// @return params The transfer parameters associated with the request ID
    function getSwapRequestParameters(bytes32 requestId) public view returns (SwapRequestParameters memory params) {
        params = swapRequestParameters[requestId];
    }

    /// @notice Checks if a destination chain ID is allowed
    /// @param chainId The chain ID to check
    /// @return True if the chain ID is allowed, false otherwise
    function getAllowedDstChainId(uint256 chainId) external view returns (bool) {
        return allowedDstChainIds[chainId];
    }

    /// @notice Returns the token mapping for a source token and destination chain ID
    /// @param srcToken The address of the source token
    /// @param dstChainId The destination chain ID
    /// @return The address of the mapped token on the destination chain
    function getTokenMapping(address srcToken, uint256 dstChainId) external view returns (address) {
        return tokenMappings[srcToken][dstChainId];
    }

    /// @notice Returns the total swap fees balance for a given token
    /// @param token The address of the token
    /// @return The total swap fees balance as a uint256
    function getTotalVerificationFeeBalance(address token) external view returns (uint256) {
        return totalVerificationFeeBalance[token];
    }

    /// @notice Returns an array of fulfilled transfer request IDs
    /// @return An array of bytes32 representing fulfilled transfers
    function getFulfilledTransfers() external view returns (bytes32[] memory) {
        return fulfilledTransfers.values();
    }

    /// @notice Returns an array of unfulfilled solver refund request IDs
    /// @return An array of bytes32 representing unfulfilled solver refunds
    function getUnfulfilledSolverRefunds() external view returns (bytes32[] memory) {
        return unfulfilledSolverRefunds.values();
    }

    /// @notice Returns an array of fulfilled solver refund request IDs
    /// @return An array of bytes32 representing fulfilled solver refunds
    function getFulfilledSolverRefunds() external view returns (bytes32[] memory) {
        return fulfilledSolverRefunds.values();
    }

    /// @notice Stores a transfer request and marks as unfulfilled
    function storeTransferRequest(bytes32 requestId, SwapRequestParameters memory params) internal {
        swapRequestParameters[requestId] = params;
        unfulfilledSolverRefunds.add(requestId);
    }

    // ---------------------- Admin Functions ----------------------

    /// @notice Sets the swap fee in BPS
    /// @param _verificationFeeBps New swap fee
    function setVerificationFeeBps(uint256 _verificationFeeBps) external onlyOwner {
        require(_verificationFeeBps <= MAX_FEE_BPS, ErrorsLib.FeeBpsExceedsThreshold(MAX_FEE_BPS));
        verificationFeeBps = _verificationFeeBps;
        emit VerificationFeeBpsUpdated(verificationFeeBps);
    }

    /// @notice Updates the BLS signature validator
    /// @param _blsValidator New validator address
    function setBlsValidator(address _blsValidator) external onlyOwner {
        blsValidator = ISignatureScheme(_blsValidator);
        emit BLSValidatorUpdated(address(blsValidator));
    }

    /// @notice Permits swap requests to a destination chain ID
    /// @param chainId Chain ID to permit
    function permitDestinationChainId(uint256 chainId) external onlyOwner {
        allowedDstChainIds[chainId] = true;
        emit DestinationChainIdPermitted(chainId);
    }

    /// @notice Blocks swap requests to a destination chain ID
    /// @param chainId Chain ID to permit
    function blockDestinationChainId(uint256 chainId) external onlyOwner {
        allowedDstChainIds[chainId] = false;
        emit DestinationChainIdBlocked(chainId);
    }

    /// @notice Sets a token mapping for a cross-chain pair
    /// @param dstChainId Destination chain ID
    /// @param dstToken Token address on the destination chain
    /// @param srcToken Token address on the source chain
    function setTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external onlyOwner {
        require(allowedDstChainIds[dstChainId], ErrorsLib.DestinationChainIdNotSupported(dstChainId));
        tokenMappings[srcToken][dstChainId] = dstToken;
        emit TokenMappingUpdated(dstChainId, dstToken, srcToken);
    }

    /// @notice Withdraws accumulated swap fees
    /// @param token Token address to withdraw
    /// @param to Recipient address
    function withdrawVerificationFee(address token, address to) external onlyOwner nonReentrant {
        uint256 amount = totalVerificationFeeBalance[token];
        totalVerificationFeeBalance[token] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit VerificationFeeWithdrawn(token, to, amount);
    }

    /// @notice Gets a transfer receipt for a given requestID
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
        )
    {
        SwapRequestReceipt storage receipt = swapRequestReceipts[_requestId];
        requestId = receipt.requestId;
        srcChainId = receipt.srcChainId;
        dstChainId = receipt.dstChainId;
        token = receipt.token;
        fulfilled = receipt.fulfilled;
        solver = receipt.solver;
        recipient = receipt.recipient;
        amount = receipt.amount;
        fulfilledAt = receipt.fulfilledAt;
    }
}
