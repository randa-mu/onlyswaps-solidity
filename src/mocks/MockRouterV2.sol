// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {AccessControlEnumerableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {ErrorsLib} from "../libraries/ErrorsLib.sol";

import {ISignatureScheme} from "../interfaces/ISignatureScheme.sol";
import {IRouter, BLS} from "../interfaces/IRouter.sol";

/// @title Router Contract for Cross-Chain Token Swaps
/// @notice This contract facilitates cross-chain token swaps with fee management and BLS signature verification.
contract MockRouterV2 is
    ReentrancyGuard,
    IRouter,
    Initializable,
    UUPSUpgradeable,
    AccessControlEnumerableUpgradeable
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice Address of the scheduled implementation upgrade
    address public scheduledImplementation;
    /// @notice Calldata for the scheduled implementation upgrade
    bytes scheduledImplementationCalldata;
    /// @notice Timestamp for the scheduled implementation upgrade
    uint256 public scheduledTimestampForUpgrade;

    /// @notice Minimum delay for upgrade operations
    uint256 public minimumContractUpgradeDelay;

    /// @notice Role identifier for the contract administrator.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Basis points divisor
    uint256 public constant BPS_DIVISOR = 10_000;

    /// @notice Max total fee in BPS
    uint256 public constant MAX_FEE_BPS = 5_000;

    /// @notice Verification fee in BPS
    uint256 public verificationFeeBps;

    /// @notice BLS validator used for swap request signature verification
    ISignatureScheme public swapRequestBlsValidator;

    /// @notice BLS validator used for validating admin threshold signatures
    ///         for stopping timed contract upgrades
    ISignatureScheme public contractUpgradeBlsValidator;

    /// @dev Stores all fulfilled swap request IDs
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

        verificationFeeBps = _verificationFeeBps;

        require(_grantRole(ADMIN_ROLE, _owner), ErrorsLib.GrantRoleFailed());
        require(_grantRole(DEFAULT_ADMIN_ROLE, _owner), ErrorsLib.GrantRoleFailed());

        swapRequestBlsValidator = ISignatureScheme(_swapRequestBlsValidator);
        contractUpgradeBlsValidator = ISignatureScheme(_contractUpgradeBlsValidator);
    }

    // ---------------------- Core Logic ----------------------

    /// @notice Initiates a swap request
    /// @param token Address of the ERC20 token to swap
    /// @param amount Amount of tokens to swap (including verification fees)
    /// @param solverFee Amount of tokens to be paid to the solver
    /// @param dstChainId Target chain ID
    /// @param recipient Address to receive swaped tokens on target chain
    /// @return requestId The unique swap request id
    function requestCrossChainSwap(
        address token,
        uint256 amount,
        uint256 solverFee,
        uint256 dstChainId,
        address recipient
    ) external nonReentrant returns (bytes32 requestId) {
        require(amount > 0, ErrorsLib.ZeroAmount());
        require(tokenMappings[token][dstChainId] != address(0), ErrorsLib.TokenNotSupported());

        // Calculate the swap fee amount (for the protocol) to be deducted from the total fee
        // based on the total fee provided
        (uint256 verificationFeeAmount, uint256 amountOut) = getVerificationFeeAmount(amount);
        // Calculate the solver fee by subtracting the swap fee from the total fee
        // The solver fee is the remaining portion of the fee
        // The total fee must be greater than the swap fee to ensure the solver is compensated
        require(solverFee > 0, ErrorsLib.FeeTooLow());

        // Accumulate the total swap fees balance for the specified token
        totalVerificationFeeBalance[token] += verificationFeeAmount;

        // Generate unique nonce and map it to sender
        uint256 nonce = ++currentNonce;
        nonceToRequester[nonce] = msg.sender;

        SwapRequestParameters memory params =
            buildSwapRequestParameters(token, amountOut, verificationFeeAmount, solverFee, dstChainId, recipient, nonce);

        requestId = getSwapRequestId(params);

        storeSwapRequest(requestId, params);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount + solverFee);

        emit SwapRequested(
            requestId,
            getChainID(),
            dstChainId,
            token,
            msg.sender,
            recipient,
            amountOut,
            solverFee,
            nonce,
            block.timestamp
        );
    }

    /// @notice Updates the solver fee for an unfulfilled swap request
    /// @param requestId The unique ID of the swap request to update
    /// @param newFee The new solver fee to be set for the swap request
    function updateSolverFeesIfUnfulfilled(bytes32 requestId, uint256 newFee) external nonReentrant {
        SwapRequestParameters storage params = swapRequestParameters[requestId];
        require(!params.executed, ErrorsLib.AlreadyFulfilled());
        require(params.sender == msg.sender, ErrorsLib.UnauthorisedCaller());
        require(newFee > params.solverFee, ErrorsLib.NewFeeTooLow(newFee, params.solverFee));

        IERC20(params.token).safeTransferFrom(msg.sender, address(this), newFee - params.solverFee);

        // Update the fees in the stored params
        params.solverFee = newFee;

        // Emit event if needed for tracking fee updates (optional)
        emit SwapRequestSolverFeeUpdated(requestId);
    }

    /// @notice Relays tokens to the recipient and stores a receipt
    /// @param token The token being relayed
    /// @param recipient The target recipient of the tokens
    /// @param amountOut The amount transferred to the recipient on the destination chain
    /// @param requestId The original request ID from the source chain
    /// @param srcChainId The ID of the source chain where the request originated
    function relayTokens(address token, address recipient, uint256 amountOut, bytes32 requestId, uint256 srcChainId)
        external
        nonReentrant
    {
        require(!swapRequestReceipts[requestId].fulfilled, ErrorsLib.AlreadyFulfilled());
        require(token != address(0) && recipient != address(0), ErrorsLib.InvalidTokenOrRecipient());
        require(amountOut > 0, ErrorsLib.ZeroAmount());

        fulfilledTransfers.add(requestId);

        IERC20(token).safeTransferFrom(msg.sender, recipient, amountOut);

        swapRequestReceipts[requestId] = SwapRequestReceipt({
            requestId: requestId,
            srcChainId: srcChainId,
            dstChainId: getChainID(),
            token: token,
            fulfilled: true, // indicates the transfer was fulfilled, prevents double fulfillment
            solver: msg.sender,
            recipient: recipient,
            amountOut: amountOut,
            fulfilledAt: block.timestamp
        });

        emit SwapRequestFulfilled(
            requestId, srcChainId, getChainID(), token, msg.sender, recipient, amountOut, block.timestamp
        );
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

        (, bytes memory messageAsG1Bytes,) = swapRequestParametersToBytes(requestId);
        require(
            swapRequestBlsValidator.verifySignature(
                messageAsG1Bytes, signature, swapRequestBlsValidator.getPublicKeyBytes()
            ),
            ErrorsLib.BLSSignatureVerificationFailed()
        );

        fulfilledSolverRefunds.add(requestId);
        unfulfilledSolverRefunds.remove(requestId);
        params.executed = true;

        uint256 solverRefund = params.amountOut + params.solverFee;

        IERC20(params.token).safeTransfer(solver, solverRefund);

        emit SolverPayoutFulfilled(requestId);
    }

    // ---------------------- Utility & View ----------------------

    /// @notice Converts swap request parameters to a message as bytes and BLS format for signing
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
            params.amountOut,
            params.srcChainId,
            params.dstChainId,
            params.nonce
        );
        (uint256 x, uint256 y) = swapRequestBlsValidator.hashToPoint(message);
        messageAsG1Point = BLS.PointG1({x: x, y: y});
        messageAsG1Bytes = swapRequestBlsValidator.hashToBytes(message);
    }

    /// @notice Converts contract upgrade parameters to a message as bytes and BLS format for signing
    /// @return message The encoded message bytes
    /// @return messageAsG1Bytes The message hashed to BLS G1 bytes
    /// @return messageAsG1Point The message hashed to BLS G1 point
    function contractUpgradeParamsToBytes() public view returns (bytes memory, bytes memory, BLS.PointG1 memory) {
        bytes memory message =
            abi.encode(scheduledImplementation, scheduledImplementationCalldata, scheduledTimestampForUpgrade);
        (uint256 x, uint256 y) = contractUpgradeBlsValidator.hashToPoint(message);
        BLS.PointG1 memory messageAsG1Point = BLS.PointG1({x: x, y: y});
        bytes memory messageAsG1Bytes = contractUpgradeBlsValidator.hashToBytes(message);

        return (message, messageAsG1Bytes, messageAsG1Point);
    }

    /// @notice Builds swap request parameters based on the provided details
    /// @param token The address of the token to be swapped
    /// @param amountOut The amount of tokens to be swapped
    /// @param verificationFeeAmount The verification fee amount
    /// @param solverFeeAmount The solver fee amount
    /// @param dstChainId The destination chain ID
    /// @param recipient The address that will receive the tokens
    /// @param nonce A unique nonce for the request
    /// @return swapRequestParams A SwapRequestParameters struct containing the transfer parameters.
    function buildSwapRequestParameters(
        address token,
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
            token: token,
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
        require(verificationFeeBps > 0, ErrorsLib.InvalidFeeBps());
        uint256 verificationFee = (amountToSwap * verificationFeeBps) / BPS_DIVISOR;
        return (verificationFee, amountToSwap - verificationFee);
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
                p.token,
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

    /// @notice Retrieves the current version of the contract
    /// @return The current version of the contract
    function getVersion() external pure returns (string memory) {
        return "2.0.0";
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

    /// @notice Retrieves the token mapping for a given source token and destination chain ID
    /// @param srcToken The address of the source token
    /// @param dstChainId The destination chain ID
    /// @return The address of the mapped destination token
    function getTokenMapping(address srcToken, uint256 dstChainId) external view returns (address) {
        return tokenMappings[srcToken][dstChainId];
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
    /// @return token The address of the token involved in the transfer
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
            address token,
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
        token = receipt.token;
        fulfilled = receipt.fulfilled;
        solver = receipt.solver;
        recipient = receipt.recipient;
        amountOut = receipt.amountOut;
        fulfilledAt = receipt.fulfilledAt;
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

    /// @notice Updates the swap request BLS signature validator contract
    /// @param _swapRequestBlsValidator The new swap request BLS validator contract address
    function setSwapRequestBlsValidator(address _swapRequestBlsValidator) external onlyAdmin {
        swapRequestBlsValidator = ISignatureScheme(_swapRequestBlsValidator);
        emit BLSValidatorUpdated(address(swapRequestBlsValidator));
    }

    /// @notice Updates the contract upgrade BLS validator contract
    /// @param _contractUpgradeBlsValidator The new contract upgrade BLS validator contract address
    function setContractUpgradeBlsValidator(address _contractUpgradeBlsValidator) external onlyAdmin {
        contractUpgradeBlsValidator = ISignatureScheme(_contractUpgradeBlsValidator);
        emit ContractUpgradeBLSValidatorUpdated(address(contractUpgradeBlsValidator));
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
        tokenMappings[srcToken][dstChainId] = dstToken;
        emit TokenMappingUpdated(dstChainId, dstToken, srcToken);
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

    // ---------------------- Scheduled Upgrade Functions ----------------------

    /// @notice Schedules a contract upgrade
    /// @param _newImplementation The address of the new implementation contract
    /// @param _upgradeCalldata The calldata to be sent to the new implementation
    /// @param _upgradeTime The time at which the upgrade can be executed
    function scheduleUpgrade(address _newImplementation, bytes calldata _upgradeCalldata, uint256 _upgradeTime)
        external
        onlyAdmin
    {
        require(_newImplementation != address(0), ErrorsLib.ZeroAddress());
        require(_upgradeTime > block.timestamp, ErrorsLib.UpgradeTimeMustBeInTheFuture());

        scheduledImplementation = _newImplementation;
        scheduledTimestampForUpgrade = _upgradeTime;
        scheduledImplementationCalldata = _upgradeCalldata;

        emit UpgradeScheduled(_newImplementation, _upgradeTime);
    }

    /// @notice Cancels a scheduled upgrade
    /// @param signature The BLS signature authorizing the cancellation
    function cancelUpgrade(bytes calldata signature) external {
        require(
            block.timestamp < scheduledTimestampForUpgrade,
            ErrorsLib.TooLateToCancelUpgrade(scheduledTimestampForUpgrade)
        );
        require(scheduledImplementation != address(0), ErrorsLib.NoUpgradePending());

        (, bytes memory messageAsG1Bytes,) = contractUpgradeParamsToBytes();

        require(
            contractUpgradeBlsValidator.verifySignature(
                messageAsG1Bytes, signature, contractUpgradeBlsValidator.getPublicKeyBytes()
            ),
            ErrorsLib.BLSSignatureVerificationFailed()
        );

        address cancelledImplementation = scheduledImplementation;
        scheduledImplementation = address(0);
        scheduledTimestampForUpgrade = 0;
        scheduledImplementationCalldata = "";
        emit UpgradeCancelled(cancelledImplementation);
    }

    /// @notice Executes a scheduled upgrade
    function executeUpgrade() external {
        require(scheduledImplementation != address(0), ErrorsLib.NoUpgradePending());
        require(
            block.timestamp >= scheduledTimestampForUpgrade, ErrorsLib.UpgradeTooEarly(scheduledTimestampForUpgrade)
        );

        upgradeToAndCall(scheduledImplementation, scheduledImplementationCalldata);

        // Reset pending upgrade before upgrading
        scheduledImplementation = address(0);
        scheduledTimestampForUpgrade = 0;
        scheduledImplementationCalldata = "";

        emit UpgradeExecuted(scheduledImplementation);
    }

    // ---------------------- Internal Functions ----------------------

    /// @dev Required by UUPS to restrict upgrades.
    function _authorizeUpgrade(address /* newImplementation */ ) internal view override {
        // Only allow calls coming from within this contract
        require(msg.sender == address(this), ErrorsLib.UpgradeMustGoThroughExecuteUpgrade());
    }

    /// @notice Stores a swap request and marks as unfulfilled
    function storeSwapRequest(bytes32 requestId, SwapRequestParameters memory params) internal {
        swapRequestParameters[requestId] = params;
        unfulfilledSolverRefunds.add(requestId);
    }
}
