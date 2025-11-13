// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {
    AccessControlEnumerableUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {ISignatureScheme} from "bls-solidity/interfaces/ISignatureScheme.sol";

import {ScheduledUpgradeable} from "../ScheduledUpgradeable.sol";

import {ErrorsLib} from "../libraries/ErrorsLib.sol";

import {IRouter} from "../interfaces/IRouter.sol";

import {Permit2Relayer} from "../Permit2Relayer.sol";
import {IPermit2} from "uniswap-permit2/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "uniswap-permit2/interfaces/ISignatureTransfer.sol";

import {IHookExecutor, Hook} from "../interfaces/IHookExecutor.sol";

/// @title Mock Version 2 of the Router Contract for Cross-Chain Token Swaps
/// @notice New version of the MockRouterV1 contract to upgrade to for testing purposes
/// @notice This contract facilitates cross-chain token swaps with fee management and BLS signature verification.
contract MockRouterV2 is ReentrancyGuard, IRouter, ScheduledUpgradeable, AccessControlEnumerableUpgradeable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Role identifier for the contract administrator.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Basis points divisor
    uint256 public constant BPS_DIVISOR = 10_000; // Basis points divisor (1 BPS = 0.01%)

    /// @notice Max total fee in BPS
    uint256 public constant MAX_FEE_BPS = 5_000; // 50%

    /// @notice Verification fee in BPS
    uint256 public verificationFeeBps;

    /// @dev Cancellation window for staged swap requests (default: 1 days)
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

    /// @notice Refund amounts for solvers per request ID
    mapping(bytes32 => uint256) public solverFeeRefunds;

    /// @notice The Permit2Relayer contract
    Permit2Relayer public permit2Relayer;

    /// @notice The HookExecutor contract address
    address public hookExecutor;

    /// @notice Pre and Post hooks mapped to request ids
    mapping(bytes32 => Hook[]) private preSwapHooks;
    mapping(bytes32 => Hook[]) private postSwapHooks;

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
    /// @param amountIn Amount of tokens to swap
    /// @param amountOut Expected amount of tokens to be received on the destination chain
    /// @param solverFee The solver fee (in token units) to be paid by the user
    /// @param dstChainId Target chain ID
    /// @param recipient Address to receive swaped tokens on target chain
    /// @return requestId The unique swap request id
    function requestCrossChainSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 solverFee,
        uint256 dstChainId,
        address recipient,
        Hook[] calldata prehooks,
        Hook[] calldata posthooks
    ) external nonReentrant returns (bytes32 requestId) {
        _validateSwapRequestParameters(amountIn, amountOut, recipient, dstChainId, tokenIn, tokenOut, solverFee);

        // Calculate the swap fee (for the protocol) to be deducted from the amountIn
        (uint256 verificationFeeAmount, uint256 amountInAfterFee) = getVerificationFeeAmount(amountIn);

        // Accumulate the total verification fees balance for the specified token
        totalVerificationFeeBalance[tokenIn] += verificationFeeAmount;

        // Generate unique nonce and map it to sender
        uint256 nonce = ++currentSwapRequestNonce;
        nonceToRequester[nonce] = msg.sender;

        SwapRequestParameters memory params = buildSwapRequestParameters(
            msg.sender, tokenIn, tokenOut, amountOut, verificationFeeAmount, solverFee, dstChainId, recipient, nonce
        );

        requestId = keccak256(
            abi.encode(
                params.sender,
                params.recipient,
                params.tokenIn,
                params.tokenOut,
                params.amountOut,
                getChainId(), // the srcChainId is always the current chain ID
                params.dstChainId,
                params.nonce,
                prehooks,
                posthooks
            )
        );

        storeSwapRequest(requestId, params);
        // Store hooks associated with this request
        storeHooks(requestId, prehooks, posthooks);

        // Track the solver refund per request id
        solverFeeRefunds[requestId] = amountInAfterFee + params.solverFee;

        /// @dev Execute pre-swap hooks
        _executeHooks(prehooks);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn + solverFee);

        emit SwapRequested(requestId, getChainId(), dstChainId);
    }

    /// @notice Initiates a swap request using Permit2 for token transfer approval
    /// @param params Struct containing all parameters for the swap request
    /// @return requestId The unique swap request id
    function requestCrossChainSwapPermit2(RequestCrossChainSwapPermit2Params calldata params)
        external
        nonReentrant
        returns (bytes32 requestId)
    {
        _validateSwapRequestParameters(
            params.amountIn,
            params.amountOut,
            params.recipient,
            params.dstChainId,
            params.tokenIn,
            params.tokenOut,
            params.solverFee
        );

        requestId = _processPermit2SwapRequest(params);

        emit SwapRequested(requestId, getChainId(), params.dstChainId);
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
        solverFeeRefunds[requestId] = solverFeeRefunds[requestId] - params.solverFee + newFee;
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
    /// @param prehooks Pre-swap hooks to execute
    /// @param posthooks Post-swap hooks to execute
    function relayTokens(
        address solverRefundAddress,
        bytes32 requestId,
        address sender,
        address recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 srcChainId,
        uint256 nonce,
        Hook[] calldata prehooks,
        Hook[] calldata posthooks
    ) external nonReentrant {
        _validateRelayRequest(
            requestId, sender, recipient, tokenIn, tokenOut, amountOut, srcChainId, solverRefundAddress
        );

        _validateRequestId(
            requestId, sender, recipient, tokenIn, tokenOut, amountOut, srcChainId, nonce, prehooks, posthooks
        );

        _processTokenRelay(requestId, tokenOut, recipient, amountOut, posthooks);

        _storeRelayReceipt(requestId, srcChainId, tokenIn, tokenOut, solverRefundAddress, recipient, amountOut);

        emit SwapRequestFulfilled(requestId, srcChainId, getChainId());
    }

    /// @notice Relays tokens using Permit2 for token transfer approval and stores a receipt
    /// @param params Struct containing all parameters for relaying tokens
    function relayTokensPermit2(RelayTokensPermit2Params calldata params) external nonReentrant {
        _validateRelayRequest(
            params.requestId,
            params.sender,
            params.recipient,
            params.tokenIn,
            params.tokenOut,
            params.amountOut,
            params.srcChainId,
            params.solverRefundAddress
        );
        _validateRequestId(
            params.requestId,
            params.sender,
            params.recipient,
            params.tokenIn,
            params.tokenOut,
            params.amountOut,
            params.srcChainId,
            params.nonce,
            params.prehooks,
            params.posthooks
        );

        fulfilledTransfers.add(params.requestId);

        IPermit2.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            nonce: params.permitNonce,
            deadline: params.permitDeadline,
            permitted: ISignatureTransfer.TokenPermissions({token: params.tokenOut, amount: params.amountOut})
        });
        permit2Relayer.relayTokensPermit2(
            params.requestId,
            params.solver,
            params.recipient,
            abi.encode(params.solverRefundAddress),
            permit,
            params.signature
        );

        /// @dev Execute post-swap hooks
        _executeHooks(params.posthooks);

        _storeRelayReceipt(
            params.requestId,
            params.srcChainId,
            params.tokenIn,
            params.tokenOut,
            params.solverRefundAddress,
            params.recipient,
            params.amountOut
        );

        emit SwapRequestFulfilled(params.requestId, params.srcChainId, getChainId());
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
        require(params.srcChainId == getChainId(), ErrorsLib.SourceChainIdMismatch(params.srcChainId, getChainId()));

        (, bytes memory messageAsG1Bytes) = swapRequestParametersToBytes(requestId, solver);
        require(
            swapRequestBlsValidator.verifySignature(messageAsG1Bytes, signature),
            ErrorsLib.BLSSignatureVerificationFailed()
        );

        fulfilledSolverRefunds.add(requestId);
        unfulfilledSolverRefunds.remove(requestId);
        params.executed = true;

        uint256 solverRefund = solverFeeRefunds[requestId];
        delete solverFeeRefunds[requestId];
        delete preSwapHooks[requestId];
        delete postSwapHooks[requestId];

        IERC20(params.tokenIn).safeTransfer(solver, solverRefund);

        emit SolverPayoutFulfilled(requestId);
    }

    /// @notice Stages a swap request for cancellation after the cancellation window
    /// @param requestId The unique ID of the swap request to cancel
    function stageSwapRequestCancellation(bytes32 requestId) external nonReentrant {
        SwapRequestParameters storage params = swapRequestParameters[requestId];
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

        uint256 totalRefund = solverFeeRefunds[requestId] + params.verificationFee;

        delete solverFeeRefunds[requestId];
        delete preSwapHooks[requestId];
        delete postSwapHooks[requestId];

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
        SwapRequestParametersWithHooks memory params = getSwapRequestParameters(requestId);
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
            params.nonce,
            params.prehooks,
            params.posthooks
        );
        messageAsG1Bytes = swapRequestBlsValidator.hashToBytes(message);
    }

    /// @notice Builds swap request parameters based on the provided details
    /// @param sender The address initiating the swap request
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
        address sender,
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
            sender: sender,
            recipient: recipient,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountOut: amountOut,
            srcChainId: getChainId(),
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
    function getSwapRequestId(SwapRequestParametersWithHooks memory p) public view returns (bytes32) {
        /// @dev The executed parameter is not used in the request ID hash as it is mutable
        return keccak256(
            abi.encode(
                p.sender,
                p.recipient,
                p.tokenIn,
                p.tokenOut,
                p.amountOut,
                getChainId(), // the srcChainId is always the current chain ID
                p.dstChainId,
                p.nonce,
                p.prehooks,
                p.posthooks
            )
        );
    }

    /// @notice Retrieves the current version of the contract
    /// @return The current version of the contract
    function getVersion() public pure returns (string memory) {
        return "1.2.0";
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

    /// @notice Retrieves the swap request parameters with hooks for a given request ID
    /// @param requestId The unique ID of the swap request
    /// @return swapRequestParamsWithHooks The swap request parameters with associated hooks
    function getSwapRequestParameters(bytes32 requestId)
        public
        view
        returns (SwapRequestParametersWithHooks memory swapRequestParamsWithHooks)
    {
        SwapRequestParameters memory params = swapRequestParameters[requestId];
        Hook[] memory preHooks = preSwapHooks[requestId];
        Hook[] memory postHooks = postSwapHooks[requestId];

        swapRequestParamsWithHooks = SwapRequestParametersWithHooks({
            sender: params.sender,
            recipient: params.recipient,
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            amountOut: params.amountOut,
            srcChainId: params.srcChainId,
            dstChainId: params.dstChainId,
            verificationFee: params.verificationFee,
            solverFee: params.solverFee,
            nonce: params.nonce,
            executed: params.executed,
            requestedAt: params.requestedAt,
            prehooks: preHooks,
            posthooks: postHooks
        });
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

    /// @notice Sets the Permit2Relayer contract address
    /// @param _permit2Relayer The Permit2Relayer contract address
    function setPermit2Relayer(address _permit2Relayer) external onlyAdmin {
        require(_permit2Relayer != address(0), ErrorsLib.ZeroAddress());
        permit2Relayer = Permit2Relayer(_permit2Relayer);
        emit Permit2RelayerUpdated(_permit2Relayer);
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

    /// @notice Sets the hook executor contract address.
    /// @param _hookExecutor The address of the new hook executor contract.
    function setHookExecutor(address _hookExecutor) external onlyAdmin {
        hookExecutor = _hookExecutor;
        emit HookExecutorUpdated(_hookExecutor);
    }

    /// @notice Updates the gas limit for the callExactCheck hook executor.
    /// @param gasForCallExactCheck_ The new gas limit to set for callExactCheck.
    function setGasForCallExactCheck(uint32 gasForCallExactCheck_) external onlyAdmin {
        // Cache the interface to avoid repeated casting
        IHookExecutor executor = IHookExecutor(hookExecutor);

        // Revert if the new gas value is the same as the current one.
        if (gasForCallExactCheck_ == executor.gasForCallExactCheck()) {
            revert ErrorsLib.GasForCallExactCheckAlreadySet();
        }

        // Update the gas limit in the hook executor contract.
        executor.setGasForCallExactCheck(gasForCallExactCheck_);

        // Emit an event to signal the update.
        emit GasForCallExactCheckSet(gasForCallExactCheck_);
    }

    // ---------------------- Internal Functions ----------------------

    /// @notice Stores a swap request in the contract state and marks it as unfulfilled for solver refunds.
    /// @param requestId The unique identifier for the swap request.
    /// @param params The swap request parameters to store.
    function storeSwapRequest(bytes32 requestId, SwapRequestParameters memory params) internal {
        swapRequestParameters[requestId] = params;
        unfulfilledSolverRefunds.add(requestId);
    }

    /// @notice Stores pre-swap and post-swap hooks associated with a swap request.
    /// @param requestId The unique identifier for the swap request.
    /// @param preHooks Array of pre-swap hooks to store.
    /// @param postHooks Array of post-swap hooks to store.
    function storeHooks(bytes32 requestId, Hook[] memory preHooks, Hook[] memory postHooks) internal {
        preSwapHooks[requestId] = preHooks;
        postSwapHooks[requestId] = postHooks;
    }

    /// @notice Executes an array of hooks through the hook executor contract.
    /// @param hooks Array of hooks to execute.
    function _executeHooks(Hook[] memory hooks) internal {
        require(hookExecutor != address(0), ErrorsLib.ZeroAddress());
        if (hooks.length > 0) {
            IHookExecutor(hookExecutor).execute(hooks);
        }
    }

    /// @notice Validates the permit2 swap request parameters
    /// @param amountIn The amount of input tokens for the swap
    /// @param amountOut The amount of output tokens for the swap
    /// @param recipient The address receiving the swapped tokens
    /// @param dstChainId The destination chain ID for the swap
    /// @param tokenIn The address of the input token on the source chain
    /// @param tokenOut The address of the output token on the destination chain
    /// @param solverFee The fee offered to the solver for processing the swap
    function _validateSwapRequestParameters(
        uint256 amountIn,
        uint256 amountOut,
        address recipient,
        uint256 dstChainId,
        address tokenIn,
        address tokenOut,
        uint256 solverFee
    ) internal view {
        require(amountIn > 0 && amountOut > 0, ErrorsLib.ZeroAmount());
        require(recipient != address(0), ErrorsLib.ZeroAddress());
        require(allowedDstChainIds[dstChainId], ErrorsLib.DestinationChainIdNotSupported(dstChainId));
        require(isDstTokenMapped(tokenIn, dstChainId, tokenOut), ErrorsLib.TokenNotSupported());
        require(solverFee > 0, ErrorsLib.FeeTooLow());
    }

    /// @notice Processes the permit2 swap request
    /// @param params The parameters of the permit2 swap request to process.
    function _processPermit2SwapRequest(RequestCrossChainSwapPermit2Params calldata params)
        internal
        returns (bytes32 requestId)
    {
        (uint256 verificationFeeAmount, uint256 amountInAfterFee) = getVerificationFeeAmount(params.amountIn);

        totalVerificationFeeBalance[params.tokenIn] += verificationFeeAmount;

        uint256 nonce = ++currentSwapRequestNonce;
        nonceToRequester[nonce] = params.requester;

        requestId = _buildAndStorePermit2Request(params, verificationFeeAmount, amountInAfterFee, nonce);

        _executePermit2HooksAndTransfer(params);
    }

    /// @notice Builds and stores the permit2 swap request
    /// @param params The parameters of the permit2 swap request to build and store.
    /// @param verificationFeeAmount The calculated verification fee amount.
    /// @param amountInAfterFee The amount after deducting the verification fee.
    /// @param nonce The unique nonce for the swap request.
    /// @return requestId The unique identifier for the stored swap request.
    function _buildAndStorePermit2Request(
        RequestCrossChainSwapPermit2Params calldata params,
        uint256 verificationFeeAmount,
        uint256 amountInAfterFee,
        uint256 nonce
    ) internal returns (bytes32 requestId) {
        SwapRequestParameters memory swapParams = buildSwapRequestParameters(
            params.requester,
            params.tokenIn,
            params.tokenOut,
            params.amountOut,
            verificationFeeAmount,
            params.solverFee,
            params.dstChainId,
            params.recipient,
            nonce
        );

        // Generate request ID using direct encoding instead of creating full struct
        requestId = keccak256(
            abi.encode(
                swapParams.sender,
                swapParams.recipient,
                swapParams.tokenIn,
                swapParams.tokenOut,
                swapParams.amountOut,
                getChainId(),
                swapParams.dstChainId,
                swapParams.nonce,
                params.prehooks,
                params.posthooks
            )
        );

        storeSwapRequest(requestId, swapParams);
        storeHooks(requestId, params.prehooks, params.posthooks);

        solverFeeRefunds[requestId] = amountInAfterFee + swapParams.solverFee;
    }

    /// @notice Executes hooks and handles permit2 transfer
    /// @param params The parameters of the permit2 swap request.
    function _executePermit2HooksAndTransfer(RequestCrossChainSwapPermit2Params calldata params) internal {
        _executeHooks(params.prehooks);
        _handlePermit2Transfer(params);
    }

    /// @notice Handles the permit2 transfer
    /// @param params The parameters of the permit2 swap request.
    function _handlePermit2Transfer(RequestCrossChainSwapPermit2Params calldata params) internal {
        IPermit2.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            nonce: params.permitNonce,
            deadline: params.permitDeadline,
            permitted: ISignatureTransfer.TokenPermissions({
                token: params.tokenIn, amount: params.amountIn + params.solverFee
            })
        });

        permit2Relayer.requestCrossChainSwapPermit2(
            address(this),
            params.requester,
            params.tokenIn,
            params.tokenOut,
            params.amountIn,
            params.amountOut,
            params.solverFee,
            params.dstChainId,
            params.recipient,
            permit,
            params.signature,
            abi.encode(params.prehooks, params.posthooks)
        );
    }

    /// @notice Validates the relay request parameters
    /// @param requestId The unique identifier for the swap request.
    /// @param sender The address initiating the swap request.
    /// @param recipient The address receiving the swapped tokens.
    /// @param tokenIn The address of the input token on the source chain.
    /// @param tokenOut The address of the output token on the destination chain.
    /// @param amountOut The amount of tokens to be swapped.
    /// @param srcChainId The source chain ID from which the request originated.
    /// @param solverRefundAddress The address to which the solver refund will be sent.
    function _validateRelayRequest(
        bytes32 requestId,
        address sender,
        address recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 srcChainId,
        address solverRefundAddress
    ) internal view {
        require(!swapRequestReceipts[requestId].fulfilled, ErrorsLib.AlreadyFulfilled());
        require(
            tokenIn != address(0) && tokenOut != address(0) && sender != address(0) && recipient != address(0),
            ErrorsLib.InvalidTokenOrRecipient()
        );
        require(solverRefundAddress != address(0), ErrorsLib.ZeroAddress());
        require(amountOut > 0, ErrorsLib.ZeroAmount());
        require(
            srcChainId != getChainId(),
            ErrorsLib.SourceChainIdShouldBeDifferentFromDestination(srcChainId, getChainId())
        );
    }

    /// @notice Validates the request ID matches the parameters
    /// @param requestId The unique identifier for the swap request.
    /// @param sender The address initiating the swap request.
    /// @param recipient The address receiving the swapped tokens.
    /// @param tokenIn The address of the input token on the source chain.
    /// @param tokenOut The address of the output token on the destination chain.
    /// @param amountOut The amount of tokens to be swapped.
    /// @param srcChainId The source chain ID from which the request originated.
    /// @param nonce The unique nonce for the swap request.
    /// @param prehooks Array of pre-swap hooks associated with the swap request.
    /// @param posthooks Array of post-swap hooks associated with the swap request.
    function _validateRequestId(
        bytes32 requestId,
        address sender,
        address recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 srcChainId,
        uint256 nonce,
        Hook[] calldata prehooks,
        Hook[] calldata posthooks
    ) internal view {
        bytes32 expectedRequestId = keccak256(
            abi.encode(
                sender, recipient, tokenIn, tokenOut, amountOut, srcChainId, getChainId(), nonce, prehooks, posthooks
            )
        );
        require(requestId == expectedRequestId, ErrorsLib.SwapRequestParametersMismatch());
    }

    /// @notice Processes the token transfer and hooks execution
    /// @param requestId The unique identifier for the swap request.
    /// @param tokenOut The address of the output token on the destination chain.
    /// @param recipient The address receiving the swapped tokens.
    /// @param amountOut The amount of tokens to be swapped.
    /// @param posthooks Array of post-swap hooks to execute after the token transfer.
    function _processTokenRelay(
        bytes32 requestId,
        address tokenOut,
        address recipient,
        uint256 amountOut,
        Hook[] calldata posthooks
    ) internal {
        fulfilledTransfers.add(requestId);
        IERC20(tokenOut).safeTransferFrom(msg.sender, recipient, amountOut);
        _executeHooks(posthooks);
    }

    /// @notice Stores the relay receipt
    /// @param requestId The unique identifier for the swap request.
    /// @param srcChainId The source chain ID from which the request originated.
    /// @param tokenIn The address of the input token on the source chain.
    /// @param tokenOut The address of the output token on the destination chain.
    /// @param solverRefundAddress The address to which the solver refund will be sent.
    /// @param recipient The address receiving the swapped tokens.
    /// @param amountOut The amount of tokens to be swapped.
    function _storeRelayReceipt(
        bytes32 requestId,
        uint256 srcChainId,
        address tokenIn,
        address tokenOut,
        address solverRefundAddress,
        address recipient,
        uint256 amountOut
    ) internal {
        swapRequestReceipts[requestId] = SwapRequestReceipt({
            requestId: requestId,
            srcChainId: srcChainId,
            dstChainId: getChainId(),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fulfilled: true,
            solver: solverRefundAddress,
            recipient: recipient,
            amountOut: amountOut,
            fulfilledAt: block.timestamp
        });
    }

    // ---------------------- Mock Upgrade Test Functions ----------------------

    /// @notice A mock function to test new functionality in the upgraded contract
    /// @return True indicating the new functionality works
    function testNewFunctionality() external pure returns (bool) {
        return true;
    }
}
