// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {
    AccessControlEnumerableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {ScheduledUpgradeable} from "../ScheduledUpgradeable.sol";

import {ErrorsLib} from "../libraries/ErrorsLib.sol";

import {ISignatureScheme} from "bls-solidity/interfaces/ISignatureScheme.sol";
import {IRouter, BLS} from "../interfaces/IRouter.sol";

/// @title Mock Version 2 of the Router Contract for Cross-Chain Token Swaps
/// @notice This contract facilitates cross-chain token swaps with fee management and BLS signature verification.
contract MockRouterV2 is ReentrancyGuard, IRouter, ScheduledUpgradeable, AccessControlEnumerableUpgradeable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Role identifier for the contract administrator.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Basis points divisor
    uint256 public constant BPS_DIVISOR = 10_000; // 100%

    /// @notice Max total fee in BPS
    uint256 public constant MAX_FEE_BPS = 5_000; // 50%

    /// @notice Verification fee in BPS
    uint256 public verificationFeeBps;

    /// @dev Cancellation window for staged swap requests
    uint256 public swapRequestCancellationWindow;

    /// @notice BLS validator used for swap request signature verification
    ISignatureScheme public swapRequestBlsValidator;

    /// @dev Stores all fulfilled swap request IDs
    EnumerableSet.Bytes32Set private fulfilledTransfers;

    /// @dev Stores all unfulfilled solver refunds by request IDs
    EnumerableSet.Bytes32Set private unfulfilledSolverRefunds;

    /// @dev Stores all fulfilled solver refunds by request IDs
    EnumerableSet.Bytes32Set private fulfilledSolverRefunds;

    /// @dev Stores all cancelled swap requests by request IDs
    EnumerableSet.Bytes32Set private cancelledSwapRequests;

    /// @notice Mapping of requestId => swap request parameters
    mapping(bytes32 => SwapRequestParameters) public swapRequestParameters;

    /// @notice Whitelisted destination chain IDs
    mapping(uint256 => bool) public allowedDstChainIds;

    /// @notice Mapping of srcToken => dstChainId => dstToken
    mapping(address => mapping(uint256 => EnumerableSet.AddressSet)) private tokenMappings;

    /// @notice Accumulated fees per token
    mapping(address => uint256) public totalVerificationFeeBalance;

    /// @dev Mapping of nonce to requester address
    mapping(uint256 => address) public nonceToRequester;

    /// @dev Mapping of requestId to transfer receipt
    mapping(bytes32 => SwapRequestReceipt) public swapRequestReceipts;

    /// @dev Mapping of requestId to cancellationInitiatedAt timestamp
    mapping(bytes32 => uint256) public swapRequestCancellationInitiatedAt;

    /// @notice Unique nonce for each swap request
    uint256 public currentSwapRequestNonce;

    /// @notice Ensures that only an account with the ADMIN_ROLE can execute a function.
    modifier onlyAdmin() {
        _checkRole(ADMIN_ROLE);
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the contract with a signature sender and owner.
    /// @param _owner Initial contract owner
    /// @param _swapRequestBlsValidator BLS validator address for swap request verification
    /// @param _contractUpgradeBlsValidator BLS validator address for contract upgrades
    /// @param _verificationFeeBps Verification fee in basis points
    function initialize(
        address _owner,
        address _swapRequestBlsValidator,
        address _contractUpgradeBlsValidator,
        uint256 _verificationFeeBps
    ) public initializer {
        __UUPSUpgradeable_init();
        __AccessControlEnumerable_init();
        __ScheduledUpgradeable_init(_contractUpgradeBlsValidator, 2 days);

        require(_verificationFeeBps > 0 && _verificationFeeBps <= MAX_FEE_BPS, ErrorsLib.InvalidFeeBps());
        require(_swapRequestBlsValidator != address(0), ErrorsLib.ZeroAddress());
        require(_grantRole(ADMIN_ROLE, _owner), ErrorsLib.GrantRoleFailed());
        require(_grantRole(DEFAULT_ADMIN_ROLE, _owner), ErrorsLib.GrantRoleFailed());

        verificationFeeBps = _verificationFeeBps;
        swapRequestBlsValidator = ISignatureScheme(_swapRequestBlsValidator);
        swapRequestCancellationWindow = 1 days;
    }

    // ---------------------- Core Logic ----------------------

    /// @notice Initiates a swap request
    /// @param tokenIn The address of the token deposited on the source chain
    /// @param tokenOut The address of the token sent to the recipient on the destination chain
    /// @param amount Amount of tokens to swap
    /// @param solverFee The solver fee (in token units) to be paid by the user
    /// @param dstChainId Target chain ID
    /// @param recipient Address to receive swaped tokens on target chain
    /// @return requestId The unique swap request id
    function requestCrossChainSwap(
        address tokenIn,
        address tokenOut,
        uint256 amount,
        uint256 solverFee,
        uint256 dstChainId,
        address recipient
    ) external nonReentrant returns (bytes32 requestId) {
        require(amount > 0, ErrorsLib.ZeroAmount());
        require(recipient != address(0), ErrorsLib.ZeroAddress());
        require(allowedDstChainIds[dstChainId], ErrorsLib.DestinationChainIdNotSupported(dstChainId));
        require(isDstTokenMapped(tokenIn, dstChainId, tokenOut), ErrorsLib.TokenNotSupported());

        // Calculate the swap fee amount (for the protocol) to be deducted from the total fee
        // based on the total fee provided
        (uint256 verificationFeeAmount, uint256 amountOut) = getVerificationFeeAmount(amount);
        // Calculate the solver fee by subtracting the swap fee from the total fee
        // The solver fee is the remaining portion of the fee
        // The total fee must be greater than the swap fee to ensure the solver is compensated
        require(solverFee > 0, ErrorsLib.FeeTooLow());

        // Accumulate the total verification fees balance for the specified token
        totalVerificationFeeBalance[tokenIn] += verificationFeeAmount;

        // Generate unique nonce and map it to sender
        uint256 nonce = ++currentSwapRequestNonce;
        nonceToRequester[nonce] = msg.sender;

        SwapRequestParameters memory params = buildSwapRequestParameters(
            tokenIn, tokenOut, amountOut, verificationFeeAmount, solverFee, dstChainId, recipient, nonce
        );

        requestId = getSwapRequestId(params);

        storeSwapRequest(requestId, params);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amount + solverFee);

        emit SwapRequested(requestId, getChainID(), dstChainId);
    }

    /// @notice Updates the solver fee for an unfulfilled swap request
    /// @param requestId The unique ID of the swap request to update
    /// @param newFee The new solver fee to be set for the swap request
    function updateSolverFeesIfUnfulfilled(bytes32 requestId, uint256 newFee) external nonReentrant {
        SwapRequestParameters storage params = swapRequestParameters[requestId];
        require(!params.executed, ErrorsLib.AlreadyFulfilled());
        require(params.sender == msg.sender, ErrorsLib.UnauthorisedCaller());
        require(newFee > params.solverFee, ErrorsLib.NewFeeTooLow(newFee, params.solverFee));

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), newFee - params.solverFee);

        // Update the fees in the stored params
        params.solverFee = newFee;

        // Emit event if needed for tracking fee updates
        emit SwapRequestSolverFeeUpdated(requestId);
    }

    /// @notice Relays tokens to the recipient and stores a receipt
    /// @param solverRefundAddress The address to refund the solver on the source chain
    /// @param requestId The original request ID from the source chain
    /// @param sender The sender of the swap request on the source chain
    /// @param recipient The target recipient of the tokens
    /// @param tokenIn The address of the token deposited on the source chain
    /// @param tokenOut The address of the token sent to the recipient on the destination chain
    /// @param amountOut The amount transferred to the recipient on the destination chain
    /// @param srcChainId The ID of the source chain where the request originated
    /// @param nonce The nonce used for the swap request on the source chain for replay protection
    function relayTokens(
        address solverRefundAddress,
        bytes32 requestId,
        address sender,
        address recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 srcChainId,
        uint256 nonce
    ) external nonReentrant {
        require(!swapRequestReceipts[requestId].fulfilled, ErrorsLib.AlreadyFulfilled());
        require(
            tokenIn != address(0) && tokenOut != address(0) && sender != address(0) && recipient != address(0),
            ErrorsLib.InvalidTokenOrRecipient()
        );
        require(solverRefundAddress != address(0), ErrorsLib.ZeroAddress());
        require(amountOut > 0, ErrorsLib.ZeroAmount());
        require(
            srcChainId != getChainID(),
            ErrorsLib.SourceChainIdShouldBeDifferentFromDestination(srcChainId, getChainID())
        );
        require(
            requestId
                == keccak256(
                    abi.encode(
                        sender,
                        recipient,
                        tokenIn,
                        tokenOut,
                        amountOut,
                        srcChainId,
                        // the relayTokens function is called on the destination chain, so dstChainId is the current chain ID
                        getChainID(),
                        nonce
                    )
                ),
            ErrorsLib.SwapRequestParametersMismatch()
        );

        fulfilledTransfers.add(requestId);

        IERC20(tokenOut).safeTransferFrom(msg.sender, recipient, amountOut);

        swapRequestReceipts[requestId] = SwapRequestReceipt({
            requestId: requestId,
            srcChainId: srcChainId,
            dstChainId: getChainID(),
            tokenIn: tokenIn,
            tokenOut: tokenOut, // tokenOut is the token being received on the destination chain
            fulfilled: true, // indicates the transfer was fulfilled, prevents double fulfillment
            solver: solverRefundAddress,
            recipient: recipient,
            amountOut: amountOut,
            fulfilledAt: block.timestamp
        });

        emit SwapRequestFulfilled(requestId, srcChainId, getChainID());
    }

    /// @notice Called with a BLS signature to approve a solver’s fulfillment of a swap request.
    /// @notice The solver is sent the amount transferred to the recipient wallet on the destination chain
    ///         plus the solver fee.
    /// @param solver The address of the solver being compensated for their service.
    /// @param requestId The unique ID of the swap request being fulfilled.
    /// @param signature The BLS signature verifying the authenticity of the request.
    function rebalanceSolver(address solver, bytes32 requestId, bytes calldata signature) external nonReentrant {
        SwapRequestParameters storage params = swapRequestParameters[requestId];
        require(!params.executed, ErrorsLib.AlreadyFulfilled());
        /// @dev rebalancing of solvers happens on the source chain router
        require(params.srcChainId == getChainID(), ErrorsLib.SourceChainIdMismatch(params.srcChainId, getChainID()));

        (, bytes memory messageAsG1Bytes) = swapRequestParametersToBytes(requestId, solver);
        require(
            swapRequestBlsValidator.verifySignature(messageAsG1Bytes, signature),
            ErrorsLib.BLSSignatureVerificationFailed()
        );

        fulfilledSolverRefunds.add(requestId);
        unfulfilledSolverRefunds.remove(requestId);
        params.executed = true;

        uint256 solverRefund = params.amountOut + params.solverFee;

        IERC20(params.tokenIn).safeTransfer(solver, solverRefund);

        emit SolverPayoutFulfilled(requestId);
    }

    /// @notice Stages a swap request for cancellation after the cancellation window
    /// @param requestId The unique ID of the swap request to cancel
    function stageSwapRequestCancellation(bytes32 requestId) external nonReentrant {
        SwapRequestParameters storage params = swapRequestParameters[requestId];
        require(params.sender == msg.sender, ErrorsLib.UnauthorisedCaller());
        require(params.sender == msg.sender, ErrorsLib.UnauthorisedCaller());
        require(!params.executed, ErrorsLib.AlreadyFulfilled());
        require(swapRequestCancellationInitiatedAt[requestId] == 0, ErrorsLib.SwapRequestCancellationAlreadyStaged());

        swapRequestCancellationInitiatedAt[requestId] = block.timestamp;

        emit SwapRequestCancellationStaged(requestId, msg.sender, block.timestamp);
    }

    /// @notice Cancels a staged swap request and refunds the user after the cancellation window
    /// @param requestId The unique ID of the swap request to cancel and refund
    function cancelSwapRequestAndRefund(bytes32 requestId, address refundRecipient) external nonReentrant {
        SwapRequestParameters storage params = swapRequestParameters[requestId];
        require(params.sender == msg.sender, ErrorsLib.UnauthorisedCaller());
        require(!params.executed, ErrorsLib.AlreadyFulfilled());
        require(swapRequestCancellationInitiatedAt[requestId] > 0, ErrorsLib.SwapRequestCancellationNotStaged());
        uint256 cancellationDeadline = swapRequestCancellationInitiatedAt[requestId] + swapRequestCancellationWindow;
        require(block.timestamp >= cancellationDeadline, ErrorsLib.SwapRequestCancellationWindowNotPassed());
        require(refundRecipient != address(0), ErrorsLib.ZeroAddress());
        require(
            totalVerificationFeeBalance[params.tokenIn] >= params.verificationFee,
            ErrorsLib.InsufficientVerificationFeeBalance()
        );
        totalVerificationFeeBalance[params.tokenIn] -= params.verificationFee;
        // Mark as executed
        params.executed = true;
        // Mark as cancelled
        cancelledSwapRequests.add(requestId);

        // Remove from unfulfilledSolverRefunds if present
        unfulfilledSolverRefunds.remove(requestId);

        // Do NOT add to fulfilledTransfers or fulfilledSolverRefunds, since this is a cancellation/refund

        uint256 totalRefund = params.amountOut + params.verificationFee + params.solverFee;

        IERC20(params.tokenIn).safeTransfer(refundRecipient, totalRefund);

        emit SwapRequestRefundClaimed(requestId, params.sender, refundRecipient, totalRefund);
    }

    // ---------------------- Utility & View ----------------------

    /// @notice Converts swap request parameters to a message as bytes and BLS format for signing
    /// @param requestId The unique request ID
    /// @param solver The address of the solver that fulfilled the request on the destination chain
    /// @return message The encoded message bytes
    /// @return messageAsG1Bytes The message hashed to BLS G1 bytes
    function swapRequestParametersToBytes(bytes32 requestId, address solver)
        public
        view
        returns (bytes memory message, bytes memory messageAsG1Bytes)
    {
        require(solver != address(0), ErrorsLib.ZeroAddress());
        SwapRequestParameters memory params = getSwapRequestParameters(requestId);
        /// @dev The order of parameters is critical for signature verification
        /// @dev The executed parameter is not used in the message hash
        message = abi.encode(
            solver,
            params.sender,
            params.recipient,
            params.tokenIn,
            params.tokenOut,
            params.amountOut,
            params.srcChainId,
            params.dstChainId,
            params.nonce
        );
        messageAsG1Bytes = swapRequestBlsValidator.hashToBytes(message);
    }

    /// @notice Builds swap request parameters based on the provided details
    /// @param tokenIn The address of the input token on the source chain
    /// @param tokenOut The address of the token sent to the recipient on the destination chain
    /// @param amountOut The amount of tokens to be swapped
    /// @param verificationFeeAmount The verification fee amount
    /// @param solverFeeAmount The solver fee amount
    /// @param dstChainId The destination chain ID
    /// @param recipient The address that will receive the tokens
    /// @param nonce A unique nonce for the request
    /// @return swapRequestParams A SwapRequestParameters struct containing the transfer parameters.
    function buildSwapRequestParameters(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 verificationFeeAmount,
        uint256 solverFeeAmount,
        uint256 dstChainId,
        address recipient,
        uint256 nonce
    ) public view returns (SwapRequestParameters memory swapRequestParams) {
        swapRequestParams = SwapRequestParameters({
            sender: msg.sender,
            recipient: recipient,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountOut: amountOut,
            srcChainId: getChainID(),
            dstChainId: dstChainId,
            verificationFee: verificationFeeAmount,
            solverFee: solverFeeAmount,
            nonce: nonce,
            executed: false,
            requestedAt: block.timestamp
        });
    }

    /// @notice Calculates the verification fee amount based on the amount to swap
    /// @param amountToSwap The amount to swap
    /// @return The calculated verification fee amount
    /// @return The amount after deducting the verification fee
    function getVerificationFeeAmount(uint256 amountToSwap) public view returns (uint256, uint256) {
        uint256 verificationFee = (amountToSwap * verificationFeeBps) / BPS_DIVISOR;
        return (verificationFee, amountToSwap - verificationFee);
    }

    /// @notice Retrieves the minimum contract upgrade delay
    /// @return The current minimum delay for upgrade operations
    function getMinimumContractUpgradeDelay() external view returns (uint256) {
        return minimumContractUpgradeDelay;
    }

    /// @notice Generates a unique request ID based on the provided swap request parameters
    /// @param p The swap request parameters
    /// @return The generated request ID
    function getSwapRequestId(SwapRequestParameters memory p) public view returns (bytes32) {
        /// @dev The executed parameter is not used in the request ID hash as it is mutable
        return keccak256(
            abi.encode(
                p.sender,
                p.recipient,
                p.tokenIn,
                p.tokenOut,
                p.amountOut,
                getChainID(), // the srcChainId is always the current chain ID
                p.dstChainId,
                p.nonce
            )
        );
    }

    /// @notice Retrieves the current chain ID
    /// @return The current chain ID
    function getChainID() public view returns (uint256) {
        return block.chainid;
    }

    /// @notice Retrieves the current verification fee in basis points
    /// @return The current verification fee in basis points
    function getVerificationFeeBps() external view returns (uint256) {
        return verificationFeeBps;
    }

    /// @notice Retrieves the address of the swap request BLS validator
    /// @return The address of the swap request BLS validator
    function getSwapRequestBlsValidator() external view returns (address) {
        return address(swapRequestBlsValidator);
    }

    /// @notice Retrieves the address of the contract upgrade BLS validator
    /// @return The address of the contract upgrade BLS validator
    function getContractUpgradeBlsValidator() external view returns (address) {
        return address(contractUpgradeBlsValidator);
    }

    /// @notice Retrieves the swap request parameters for a given request ID
    /// @param requestId The unique ID of the swap request
    /// @return swapRequestParams The swap request parameters associated with the request ID
    function getSwapRequestParameters(bytes32 requestId)
        public
        view
        returns (SwapRequestParameters memory swapRequestParams)
    {
        swapRequestParams = swapRequestParameters[requestId];
    }

    /// @notice Checks if a destination chain ID is allowed
    /// @param chainId The chain ID to check
    /// @return True if the chain ID is allowed, false otherwise
    function getAllowedDstChainId(uint256 chainId) external view returns (bool) {
        return allowedDstChainIds[chainId];
    }

    /// @notice Returns an array of cancelled swap request IDs
    /// @return An array of bytes32 representing the cancelled request IDs
    function getCancelledSwapRequests() external view returns (bytes32[] memory) {
        return cancelledSwapRequests.values();
    }

    /// @notice Retrieves the token mapping for a given source token and destination chain ID
    /// @param srcToken The address of the source token
    /// @param dstChainId The destination chain ID
    /// @return The address array of the mapped destination tokens
    function getTokenMapping(address srcToken, uint256 dstChainId) external view returns (address[] memory) {
        return tokenMappings[srcToken][dstChainId].values();
    }

    /// @notice Retrieves the total verification fee balance for a specific token
    /// @param token The address of the token
    /// @return The total verification fee balance for the specified token
    function getTotalVerificationFeeBalance(address token) external view returns (uint256) {
        return totalVerificationFeeBalance[token];
    }

    /// @notice Returns an array of swap request IDs where the tokens have been
    ///         transferred to the recipient address on the destination chain
    /// @return An array of bytes32 representing the request IDs
    function getFulfilledTransfers() external view returns (bytes32[] memory) {
        return fulfilledTransfers.values();
    }

    /// @notice Returns an array of request IDs with unfulfilled solver refunds
    /// @return An array of bytes32 representing the request IDs
    function getUnfulfilledSolverRefunds() external view returns (bytes32[] memory) {
        return unfulfilledSolverRefunds.values();
    }

    /// @notice Returns an array of request IDs with fulfilled solver refunds
    /// @return An array of bytes32 representing the request IDs
    function getFulfilledSolverRefunds() external view returns (bytes32[] memory) {
        return fulfilledSolverRefunds.values();
    }

    /// @notice Retrieves the receipt for a specific request ID
    /// @param _requestId The request ID to check
    /// @return requestId The unique ID of the swap request
    /// @return srcChainId The source chain ID from which the request originated
    /// @return dstChainId The destination chain ID where the tokens were delivered
    /// @return tokenIn The token being sent on the source chain
    /// @return tokenOut The token being received on the destination chain
    /// @return fulfilled Indicates if the transfer was fulfilled
    /// @return solver The address of the solver who fulfilled the transfer
    /// @return recipient The address that received the tokens on the destination chain
    /// @return amountOut The amount of tokens transferred to the recipient
    /// @return fulfilledAt The timestamp when the transfer was fulfilled
    function getSwapRequestReceipt(bytes32 _requestId)
        external
        view
        returns (
            bytes32 requestId,
            uint256 srcChainId,
            uint256 dstChainId,
            address tokenIn,
            address tokenOut,
            bool fulfilled,
            address solver,
            address recipient,
            uint256 amountOut,
            uint256 fulfilledAt
        )
    {
        SwapRequestReceipt storage receipt = swapRequestReceipts[_requestId];
        requestId = receipt.requestId;
        srcChainId = receipt.srcChainId;
        dstChainId = receipt.dstChainId;
        tokenIn = receipt.tokenIn;
        tokenOut = receipt.tokenOut;
        fulfilled = receipt.fulfilled;
        solver = receipt.solver;
        recipient = receipt.recipient;
        amountOut = receipt.amountOut;
        fulfilledAt = receipt.fulfilledAt;
    }

    /// @notice Checks if a destination token is mapped for a given source token and destination chain ID
    /// @param srcToken The address of the source token
    /// @param dstChainId The destination chain ID
    /// @param dstToken The address of the destination token
    /// @return True if the destination token is mapped, false otherwise
    function isDstTokenMapped(address srcToken, uint256 dstChainId, address dstToken) public view returns (bool) {
        return tokenMappings[srcToken][dstChainId].contains(dstToken);
    }

    // ---------------------- Admin Functions ----------------------

    /// @notice Sets the verification fee in basis points
    /// @param _verificationFeeBps The new verification fee in basis points
    function setVerificationFeeBps(uint256 _verificationFeeBps) external onlyAdmin {
        require(_verificationFeeBps <= MAX_FEE_BPS, ErrorsLib.FeeBpsExceedsThreshold(MAX_FEE_BPS));
        require(_verificationFeeBps > 0, ErrorsLib.InvalidFeeBps());
        verificationFeeBps = _verificationFeeBps;
        emit VerificationFeeBpsUpdated(verificationFeeBps);
    }

    /// @notice Sets the minimum delay required for scheduling contract upgrades.
    /// @param _minimumContractUpgradeDelay The new minimum delay in seconds
    /// @param signature BLS signature from the admin threshold validating the update
    function setMinimumContractUpgradeDelay(uint256 _minimumContractUpgradeDelay, bytes calldata signature)
        public
        override (IRouter, ScheduledUpgradeable)
    {
        super.setMinimumContractUpgradeDelay(_minimumContractUpgradeDelay, signature);
    }

    /// @notice Updates the swap request BLS signature validator contract
    /// @param _swapRequestBlsValidator The new swap request BLS validator contract address
    /// @param signature The BLS signature authorising the update
    function setSwapRequestBlsValidator(address _swapRequestBlsValidator, bytes calldata signature) external {
        require(_swapRequestBlsValidator != address(0), ErrorsLib.ZeroAddress());
        string memory action = "change-swap-request-bls-validator";
        uint256 nonce = ++currentNonce;
        (, bytes memory messageAsG1Bytes) = blsValidatorUpdateParamsToBytes(action, _swapRequestBlsValidator, nonce);

        require(
            contractUpgradeBlsValidator.verifySignature(messageAsG1Bytes, signature),
            ErrorsLib.BLSSignatureVerificationFailed()
        );
        swapRequestBlsValidator = ISignatureScheme(_swapRequestBlsValidator);
        emit BLSValidatorUpdated(address(swapRequestBlsValidator));
    }

    /// @notice Updates the contract upgrade BLS validator contract
    /// @param _contractUpgradeBlsValidator The new contract upgrade BLS validator contract address
    /// @param signature The BLS signature authorising the update
    function setContractUpgradeBlsValidator(address _contractUpgradeBlsValidator, bytes calldata signature)
        public
        override (IRouter, ScheduledUpgradeable)
    {
        super.setContractUpgradeBlsValidator(_contractUpgradeBlsValidator, signature);
    }

    /// @notice Permits a destination chain ID for swaps
    /// @param chainId The chain ID to be permitted
    function permitDestinationChainId(uint256 chainId) external onlyAdmin {
        allowedDstChainIds[chainId] = true;
        emit DestinationChainIdPermitted(chainId);
    }

    /// @notice Blocks a destination chain ID from being used for swaps
    /// @param chainId The chain ID to be blocked
    function blockDestinationChainId(uint256 chainId) external onlyAdmin {
        allowedDstChainIds[chainId] = false;
        emit DestinationChainIdBlocked(chainId);
    }

    /// @notice Sets the token mapping for a specific destination chain
    /// @param dstChainId The destination chain ID
    /// @param dstToken The address of the destination token
    /// @param srcToken The address of the source token
    function setTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external onlyAdmin {
        require(allowedDstChainIds[dstChainId], ErrorsLib.DestinationChainIdNotSupported(dstChainId));
        require(!tokenMappings[srcToken][dstChainId].contains(dstToken), ErrorsLib.TokenMappingAlreadyExists());
        tokenMappings[srcToken][dstChainId].add(dstToken);
        emit TokenMappingAdded(dstChainId, dstToken, srcToken);
    }

    /// @notice Removes the token mapping for a specific destination chain
    /// @param dstChainId The destination chain ID
    /// @param dstToken The address of the destination token
    /// @param srcToken The address of the source token
    function removeTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external onlyAdmin {
        require(allowedDstChainIds[dstChainId], ErrorsLib.DestinationChainIdNotSupported(dstChainId));
        require(isDstTokenMapped(srcToken, dstChainId, dstToken), ErrorsLib.TokenNotSupported());
        tokenMappings[srcToken][dstChainId].remove(dstToken);
        emit TokenMappingRemoved(dstChainId, dstToken, srcToken);
    }

    /// @notice Withdraws verification fees to a specified address
    /// @param token The token address of the withdrawn fees
    /// @param to The address receiving the withdrawn fees
    function withdrawVerificationFee(address token, address to) external onlyAdmin nonReentrant {
        uint256 amount = totalVerificationFeeBalance[token];
        require(amount > 0, ErrorsLib.ZeroAmount());
        totalVerificationFeeBalance[token] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit VerificationFeeWithdrawn(token, to, amount);
    }

    /// @notice Updates the swap request cancellation window
    /// @param newSwapRequestCancellationWindow The new cancellation window in seconds
    /// @param signature The BLS signature authorising the update
    function setCancellationWindow(uint256 newSwapRequestCancellationWindow, bytes calldata signature) external {
        require(newSwapRequestCancellationWindow >= 1 days, ErrorsLib.SwapRequestCancellationWindowTooShort());
        string memory action = "change-cancellation-window";
        uint256 nonce = ++currentNonce;
        (, bytes memory messageAsG1Bytes) =
            minimumContractUpgradeDelayParamsToBytes(action, newSwapRequestCancellationWindow, nonce);

        require(
            contractUpgradeBlsValidator.verifySignature(messageAsG1Bytes, signature),
            ErrorsLib.BLSSignatureVerificationFailed()
        );
        swapRequestCancellationWindow = newSwapRequestCancellationWindow;
        emit SwapRequestCancellationWindowUpdated(newSwapRequestCancellationWindow);
    }

    // ---------------------- Scheduled Upgrade Functions ----------------------

    /// @notice Schedules a contract upgrade
    /// @param newImplementation The address of the new implementation contract
    /// @param upgradeCalldata The calldata to be sent to the new implementation
    /// @param upgradeTime The time at which the upgrade can be executed
    /// @param signature The BLS signature authorising the upgrade
    function scheduleUpgrade(
        address newImplementation,
        bytes calldata upgradeCalldata,
        uint256 upgradeTime,
        bytes calldata signature
    ) public override (IRouter, ScheduledUpgradeable) {
        require(
            keccak256(abi.encodePacked(IRouter(newImplementation).getVersion()))
                != keccak256(abi.encodePacked(getVersion())),
            ErrorsLib.SameVersionUpgradeNotAllowed()
        );
        super.scheduleUpgrade(newImplementation, upgradeCalldata, upgradeTime, signature);
    }

    /// @notice Cancels a scheduled upgrade
    /// @param signature The BLS signature authorising the cancellation
    function cancelUpgrade(bytes calldata signature) public override (IRouter, ScheduledUpgradeable) {
        super.cancelUpgrade(signature);
    }

    /// @notice Executes a scheduled upgrade
    function executeUpgrade() public override (IRouter, ScheduledUpgradeable) {
        super.executeUpgrade();
    }

    // ---------------------- Internal Functions ----------------------

    /// @notice Stores a swap request and marks as unfulfilled
    function storeSwapRequest(bytes32 requestId, SwapRequestParameters memory params) internal {
        swapRequestParameters[requestId] = params;
        unfulfilledSolverRefunds.add(requestId);
    }

    // ---------------------- Mock Upgrade Test Functions ----------------------

    function testNewFunctionality() external pure returns (bool) {
        return true;
    }

    function getVersion() public pure returns (string memory) {
        return "2.0.0";
    }
}
