// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BLS} from "./libraries/BLS.sol";

import {IRouter} from "./interfaces/IRouter.sol";
import {ISignatureScheme} from "./interfaces/ISignatureScheme.sol";

/// @title SubscriptionRegistry
/// @notice This contract manages user-creator subscriptions.
/// It manages the creation, renewal, funding, sharing and closing of subscriptions.
/// Assumptions:
///     - subCode is unique per (user, creator, tier, duration) and generated off-chain.
///     - The Threshold Network has exclusive rights to call autoRenewFromBalance.
///     - Bridging logic and DepositVault, Router, and Settlement Wallet are external and will act on emitted events (AutoRenewed).
///     - subCode contains a binding to the user identity, which should be validated off-chain (and possibly hashed with the user address).
///     - Contract will manage a list of supported tokens per creator.
///     - The contract owner can set accepted tokens for creators.
///     - The contract abstracts away the concept of tiers, focusing on subscriptions and balances.
///     - The contract abstract away the fact that creators might be paid on different destination chains and
///     - It lets users manage their subscription and balances on the source chain.
///     - Users can fund their subscription balances with any token and only the creators supported token
///         - will be taken from their token balances.
contract SubscriptionRegistry is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IRouter public immutable router;
    /// @notice BLS validator used for signature verification
    ISignatureScheme public blsValidator;
    /// @notice Unique nonce for each swap request and user
    uint256 public currentNonce;

    /// @notice Maps user to creator to subCode
    /// @dev subCode is a unique identifier for the subscription, generated off-chain.
    /// It is expected to be a hash of the user address, creator address, tier ID, and duration.
    /// It is used to identify the subscription and manage its state.
    /// Inactive or closed subscriptions are deleted from storage.
    /// todo - subCode is expected to encode cross-chain metadata (e.g., source chain ID, destination chain ID),
    /// but this is not currently explicitly enforced or validated (TBC)
    mapping(address => mapping(address => bytes32)) public userSubscriptions;
    /// @notice Maps user to token balance
    mapping(address => mapping(address => uint256)) public userTokenBalances;
    /// @notice Maps user to creator to accepted token
    /// @dev This mapping allows the contract to know which token a user can use to pay for a subscription to a specific creator.
    /// @dev There could be cases where a creator might want to accept multiple tokens at the same time.
    /// @dev But for simplicity, we assume each creator has a single accepted token.
    /// @dev We can use a set or a list to manage multiple accepted tokens per creator in the future if needed.
    mapping(address => address) public creatorToAcceptedToken;
    /// @notice Maps consumer address to primary creator address
    mapping(address => address) public consumerToPrimary;
    /// @notice Maps creator to token balances for amounts deducted from user balances
    mapping(address => mapping(address => uint256)) public creatorBalances;

    /// @notice Emitted when a user subscribes
    event Subscribed(
        address indexed user, address indexed creator, bytes32 indexed subCode, address token, uint256 amount
    );

    /// @notice Emitted when a user tops up their balance
    event Funded(address indexed user, address indexed token, uint256 amount);

    /// @notice Emitted when renewal is performed from balance
    event AutoRenewed(
        address indexed user, address indexed creator, bytes32 indexed subCode, address token, uint256 amount
    );

    /// @notice Emitted when a subscription is closed
    event Closed(address indexed user, address indexed creator, bytes32 indexed subCode);

    /// @notice Emitted when a consumer is added to a subscription
    event SubscriptionConsumerAdded(address indexed user, address consumer);

    /// @notice Emitted when a consumer is removed from a subscription
    event SubscriptionConsumerRemoved(address indexed user, address consumer);

    /// @notice Emitted when a subscription is created
    event SubscriptionCreated(address indexed user, address indexed creator, bytes32 indexed subCode, uint256 amount);

    /// @notice Emitted when a subscription is renewed
    event SubscriptionRenewed(address indexed user, address indexed creator, bytes32 indexed subCode, uint256 amount);

    /// @notice Emitted when a creator sets an accepted token
    event AcceptedTokenSet(address indexed creator, address indexed token);

    /// @notice Emitted when a cross-chain swap is requested
    event CrossChainSwapRequested(
        address indexed caller,
        address indexed token,
        uint256 amount,
        uint256 fee,
        uint256 srcChainId,
        uint256 dstChainId,
        address recipient
    );

    constructor(address _owner, address _blsValidator, IRouter _routerContract) Ownable(_owner) {
        require(_owner != address(0), "Invalid owner address");
        blsValidator = ISignatureScheme(_blsValidator);
        require(address(_routerContract) != address(0), "Invalid router contract address");
        router = _routerContract;
    }

    /// @notice Sets the accepted token for a creator
    /// @param token The address of the token contract
    /// @param creator The address of the creator for whom the token is being set
    function setAcceptedToken(address token, address creator) external onlyOwner {
        require(token != address(0), "Invalid token address");
        require(creator != address(0), "Invalid creator address");
        creatorToAcceptedToken[creator] = token;
        emit AcceptedTokenSet(creator, token);
    }

    /// @notice Creates a subscription for a user to a specific creator and transfers tokens for the
    /// subscription from the user and allocates the tokens to the creator's balance.
    /// @param creator The address of the creator to whom the subscription is made
    /// @param subCode A unique identifier for the subscription
    /// @param amount The amount of tokens to be transferred for the subscription
    function createSubscription(address creator, bytes32 subCode, uint256 amount) external nonReentrant {
        require(creator != address(0), "Invalid creator address");
        require(subCode != bytes32(0), "Invalid subCode");
        require(amount > 0, "Amount must be greater than zero");

        address token = creatorToAcceptedToken[creator];
        require(token != address(0), "No accepted token for creator");

        creatorBalances[creator][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        userSubscriptions[msg.sender][creator] = subCode;
        emit Subscribed(msg.sender, creator, subCode, token, amount);
    }

    /// @notice Funds the subscription balance for the caller by transferring tokens to the contract
    /// @param onBehalfOf The address of the user for whom the subscription balance is being funded
    /// @param token The address of the token contract to fund the subscription
    /// @param amount The amount of tokens to be transferred to the subscription balance
    function fundSubscriptionBalance(address onBehalfOf, address token, uint256 amount) external nonReentrant {
        require(token != address(0), "Invalid token address");
        require(amount > 0, "Amount must be greater than zero");

        userTokenBalances[onBehalfOf][token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit Funded(msg.sender, token, amount);
    }

    /// @notice Withdraws a specified amount of tokens from the user's subscription balance
    /// @param token The address of the token contract from which the balance will be withdrawn
    /// @param amount The amount of tokens to withdraw
    function withdrawSubscriptionBalance(address token, uint256 amount) external nonReentrant {
        require(token != address(0), "Invalid token address");
        require(amount > 0, "Amount must be greater than zero");
        require(userTokenBalances[msg.sender][token] >= amount, "Insufficient balance");

        userTokenBalances[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Funded(msg.sender, token, amount);
    }

    /// @notice Renews a subscription for a user to a specific creator and transfers tokens for the
    /// renewal from the user's subscription balance to the creator's balance.
    /// @param creator The address of the creator to whom the subscription is renewed
    /// @param subCode A unique identifier for the subscription
    /// @param amount The amount of tokens to be transferred for the renewal
    function renewSubscription(address creator, bytes32 subCode, uint256 amount, bytes calldata signature)
        external
        nonReentrant
        onlyOwner
    {
        // Increment the nonce for unique request identification
        uint256 nonce = ++currentNonce;
        // Convert parameters to bytes for signature verification
        (, bytes memory messageAsG1Bytes,) = renewSubscriptionParamsToBytes(creator, subCode, amount, nonce);

        // Validate the BLS signature against the generated message
        require(
            blsValidator.verifySignature(messageAsG1Bytes, signature, blsValidator.getPublicKeyBytes()),
            "Invalid BLS signature"
        );

        // Validate the BLS signature against the generated message
        require(
            blsValidator.verifySignature(messageAsG1Bytes, signature, blsValidator.getPublicKeyBytes()),
            "Invalid BLS signature"
        );

        require(creator != address(0), "Invalid creator address");
        require(subCode != bytes32(0), "Invalid subCode");
        require(amount > 0, "Amount must be greater than zero");

        address token = creatorToAcceptedToken[creator];
        require(token != address(0), "No accepted token for creator");

        uint256 balance = userTokenBalances[msg.sender][token];
        require(balance >= amount, "Insufficient balance for renewal");

        userTokenBalances[msg.sender][token] -= amount;
        creatorBalances[creator][token] += amount;

        // Emit an event indicating the subscription has been renewed
        emit SubscriptionRenewed(msg.sender, creator, subCode, amount);
    }

    /// @notice Adds a consumer to the caller's subscription
    /// @param consumer The address of the consumer to be added
    function addConsumer(address consumer) external {
        require(consumer != address(0), "Invalid consumer address");

        consumerToPrimary[consumer] = msg.sender;
        emit SubscriptionConsumerAdded(msg.sender, consumer);
    }

    /// @notice Removes a consumer from the caller's subscription
    /// @param consumer The address of the consumer to be removed
    function removeConsumer(address consumer) external {
        require(consumer != address(0), "Invalid consumer address");

        // Ensure the consumer is added to the caller's subscription
        require(consumerToPrimary[consumer] == msg.sender, "Consumer not added");

        delete consumerToPrimary[consumer];
        emit SubscriptionConsumerRemoved(msg.sender, consumer);
    }

    /// @dev Requests a cross-chain token swap.
    /// This function allows the threshold network initiate a token swap across different blockchain networks
    /// for a creator.
    /// @param token The address of the token to be swapped.
    /// @param amount The amount of tokens to be swapped.
    /// @param fee The fee associated with the swap.
    /// @param dstChainId The identifier of the destination blockchain.
    /// @param creator The address of the user initiating the swap.
    /// @param signature The signature of the transaction for verification purposes.
    function requestCrossChainSwap(
        address token,
        uint256 amount,
        uint256 fee,
        uint256 dstChainId,
        address creator,
        bytes calldata signature
    ) external nonReentrant onlyOwner returns (bytes32 requestId) {
        // Increment the nonce for unique request identification
        uint256 nonce = ++currentNonce;
        // Convert parameters to bytes for signature verification
        (, bytes memory messageAsG1Bytes,) =
            crossChainTransferParamsToBytes(token, amount, fee, dstChainId, creator, nonce);
        // Validate the BLS signature against the generated message
        require(
            blsValidator.verifySignature(messageAsG1Bytes, signature, blsValidator.getPublicKeyBytes()),
            "Invalid BLS signature"
        );
        // Ensure the amount is greater than zero
        require(amount > 0, "Amount must be greater than zero");
        // Ensure the creator address is valid
        require(creator != address(0), "Invalid recipient address");

        // Check if the token is accepted by the creator
        address acceptedToken = creatorToAcceptedToken[creator];
        require(token == acceptedToken, "Token not accepted by creator");
        // Approve the token transfer to the router if not already approved
        if (IERC20(token).allowance(address(this), address(router)) < amount) {
            IERC20(token).approve(address(router), amount);
        }
        // Ensure the contract has sufficient token balance for the swap
        require(IERC20(token).balanceOf(address(this)) >= amount, "Insufficient token balance");
        // Validate the destination chain ID
        require(dstChainId > 0, "Invalid destination chain ID");
        // Ensure the fee is greater than zero
        require(fee > 0, "Fee must be greater than zero");

        // Check if the creator has enough balance to cover the swap
        require(creatorBalances[creator][token] >= amount, "Insufficient creator balance");
        // Deduct the amount from the creator's balance
        creatorBalances[creator][token] -= amount;

        // Transfer the specified amount of tokens from the contract to the router
        IERC20(token).safeTransferFrom(address(this), address(router), amount);

        // Initiate the cross-chain swap through the router
        requestId = router.requestCrossChainSwap(token, amount, fee, dstChainId, creator);

        // Emit an event for the cross-chain swap request
        emit CrossChainSwapRequested(msg.sender, token, amount, fee, getChainID(), dstChainId, creator);
    }

    /// @notice Encodes parameters for cross-chain transfer into bytes
    /// @param token The address of the token to be transferred
    /// @param amount The amount of tokens to be transferred
    /// @param fee The fee associated with the transfer
    /// @param dstChainId The identifier of the destination blockchain
    /// @param creator The address of the user initiating the transfer
    /// @param nextNonce The next nonce for the transaction
    /// @return message The encoded message as bytes
    /// @return messageAsG1Bytes The message encoded as G1 bytes
    /// @return messageAsG1Point The message represented as a G1 point
    function crossChainTransferParamsToBytes(
        address token,
        uint256 amount,
        uint256 fee,
        uint256 dstChainId,
        address creator,
        uint256 nextNonce
    ) public view returns (bytes memory message, bytes memory messageAsG1Bytes, BLS.PointG1 memory messageAsG1Point) {
        // Encode the parameters into a message
        message = abi.encode(token, amount, fee, dstChainId, creator, getChainID(), blsValidator.SCHEME_ID(), nextNonce);
        // Hash the message to a point in G1
        (uint256 x, uint256 y) = blsValidator.hashToPoint(message);
        messageAsG1Point = BLS.PointG1({x: x, y: y});
        // Convert the message to bytes in G1 format
        messageAsG1Bytes = blsValidator.hashToBytes(message);
    }

    /// @notice Encodes parameters for renewing a subscription into bytes
    /// @param creator The address of the creator to whom the subscription is renewed
    /// @param subCode A unique identifier for the subscription
    /// @param amount The amount of tokens to be transferred for the renewal
    /// @param nextNonce The next nonce for the transaction
    /// @return message The encoded message as bytes
    /// @return messageAsG1Bytes The message encoded as G1 bytes
    /// @return messageAsG1Point The message represented as a G1 point
    function renewSubscriptionParamsToBytes(address creator, bytes32 subCode, uint256 amount, uint256 nextNonce)
        public
        view
        returns (bytes memory message, bytes memory messageAsG1Bytes, BLS.PointG1 memory messageAsG1Point)
    {
        // Encode the parameters into a message
        message = abi.encode(creator, subCode, amount, getChainID(), blsValidator.SCHEME_ID(), nextNonce);
        // Hash the message to a point in G1
        (uint256 x, uint256 y) = blsValidator.hashToPoint(message);
        messageAsG1Point = BLS.PointG1({x: x, y: y});
        // Convert the message to bytes in G1 format
        messageAsG1Bytes = blsValidator.hashToBytes(message);
    }

    /// @notice Checks if a user is subscribed to a specific creator
    /// @param creator The address of the creator
    /// @param user The address of the user
    /// @return bool True if the user is subscribed, false otherwise
    function isSubscribed(address creator, address user) external view returns (bool) {
        bytes32 subCode = userSubscriptions[user][creator];
        return subCode != bytes32(0);
    }

    /// @notice Retrieves the subscription code for a user and creator
    /// @param creator The address of the creator
    /// @param user The address of the user
    /// @return bytes32 The subscription code
    function getSubscription(address creator, address user) external view returns (bytes32) {
        return userSubscriptions[user][creator];
    }

    /// @notice Gets the subscription balance for a user and token
    /// @param user The address of the user
    /// @param token The address of the token
    /// @return uint256 The subscription balance
    function getSubscriptionBalance(address user, address token) external view returns (uint256) {
        return userTokenBalances[user][token];
    }

    /// @notice Retrieves the accepted token for a creator
    /// @param creator The address of the creator
    /// @return address The accepted token address
    function getAcceptedToken(address creator) external view returns (address) {
        return creatorToAcceptedToken[creator];
    }

    /// @notice Gets the creator's balance for a specific token
    /// @param creator The address of the creator
    /// @param token The address of the token
    /// @return uint256 The creator's balance
    function getCreatorBalance(address creator, address token) external view returns (uint256) {
        return creatorBalances[creator][token];
    }

    /// @notice Retrieves the primary creator for a consumer
    /// @param consumer The address of the consumer
    /// @return address The primary creator's address
    function getConsumerPrimary(address consumer) external view returns (address) {
        return consumerToPrimary[consumer];
    }

    /// @notice Gets the subscription code for a user and creator
    /// @param user The address of the user
    /// @param creator The address of the creator
    /// @return bytes32 The subscription code
    function getUserSubscriptionCode(address user, address creator) external view returns (bytes32) {
        return userSubscriptions[user][creator];
    }

    /// @notice Returns the current EVM chain ID
    /// @return uint256 The current chain ID
    function getChainID() public view returns (uint256) {
        return block.chainid;
    }
}
