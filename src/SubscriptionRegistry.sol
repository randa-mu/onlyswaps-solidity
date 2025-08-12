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
///     - it lets users manage their subscription and balances on the source chain.
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
    //  but this is not currently explicitly enforced or validated.
    mapping(address => mapping(address => bytes32)) public userSubscriptions;
    /// @notice Maps user to token balance
    mapping(address => mapping(address => uint256)) public userTokenBalances;
    /// @notice Maps user to creator to accepted token
    /// @dev This mapping allows the contract to know which token a user can use to pay for a subscription to a specific creator.
    /// @dev There could be cases where a creator might want to accept multiple tokens at the same time.
    /// @dev But for simplicity, we assume each creator has a single accepted token.
    /// @dev We can use a set or a list to manage multiple accepted tokens per creator in the future if needed.
    mapping(address => address) public creatorToAcceptedToken;
    mapping(address => address) public consumerToPrimary;
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

    event SubscriptionCreated(address indexed user, address indexed creator, bytes32 indexed subCode, uint256 amount);

    event SubscriptionRenewed(address indexed user, address indexed creator, bytes32 indexed subCode, uint256 amount);

    // event PaymentTransferred(address indexed from, address indexed to, uint256 amount, address token);
    event AcceptedTokenSet(address indexed creator, address indexed token);

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

    function setAcceptedToken(address token, address creator) external onlyOwner {
        require(token != address(0), "Invalid token address");
        require(creator != address(0), "Invalid creator address");
        creatorToAcceptedToken[creator] = token;
        emit AcceptedTokenSet(creator, token);
    }

    function createSubscription(address creator, bytes32 subCode, uint256 amount) external nonReentrant {
        require(creator != address(0), "Invalid creator address");
        require(subCode != bytes32(0), "Invalid subCode");
        require(amount > 0, "Amount must be greater than zero");

        address token = creatorToAcceptedToken[creator];
        require(token != address(0), "No accepted token for creator");

        IERC20(token).safeTransferFrom(msg.sender, creator, amount);

        userSubscriptions[msg.sender][creator] = subCode;
        emit Subscribed(msg.sender, creator, subCode, token, amount);
    }

    function fundSubscriptionBalance(address token, address creator, uint256 amount) external nonReentrant {
        require(token != address(0), "Invalid token address");
        require(amount > 0, "Amount must be greater than zero");
        require(creator != address(0), "Invalid creator address");
        require(creatorToAcceptedToken[creator] == token, "Token not accepted by creator");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        userTokenBalances[msg.sender][token] += amount;

        emit Funded(msg.sender, token, amount);
    }

    function withdrawSubscriptionBalance(address token, uint256 amount) external nonReentrant {
        require(token != address(0), "Invalid token address");
        require(amount > 0, "Amount must be greater than zero");
        require(userTokenBalances[msg.sender][token] >= amount, "Insufficient balance");

        userTokenBalances[msg.sender][token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Funded(msg.sender, token, amount);
    }

    function renewSubscription(address creator, bytes32 subCode, uint256 amount) external nonReentrant {
        require(creator != address(0), "Invalid creator address");
        require(subCode != bytes32(0), "Invalid subCode");
        require(amount > 0, "Amount must be greater than zero");

        address token = creatorToAcceptedToken[creator];
        require(token != address(0), "No accepted token for creator");

        uint256 balance = userTokenBalances[msg.sender][token];
        require(balance >= amount, "Insufficient balance for renewal");

        userTokenBalances[msg.sender][token] -= amount;

        // Assuming the subscription is valid and exists
        emit SubscriptionRenewed(msg.sender, creator, subCode, amount);
    }

    function closeSubscription(address creator, bytes32 subCode, address recipient) external nonReentrant {
        require(creator != address(0), "Invalid creator address");
        require(subCode != bytes32(0), "Invalid subCode");
        require(recipient != address(0), "Invalid recipient address");

        // Assuming the subscription exists and is valid
        uint256 balance = userTokenBalances[msg.sender][creatorToAcceptedToken[creator]];
        require(balance > 0, "No balance to withdraw");

        // Reset user subscription
        delete userSubscriptions[msg.sender][creator];

        // Transfer the balance to the nominated recipient
        IERC20 token = IERC20(creatorToAcceptedToken[creator]);
        token.safeTransfer(recipient, balance);

        emit Closed(msg.sender, creator, subCode);
    }

    function addConsumer(address consumer) external {
        require(consumer != address(0), "Invalid consumer address");

        consumerToPrimary[consumer] = msg.sender;
        emit SubscriptionConsumerAdded(msg.sender, consumer);
    }

    function removeConsumer(address consumer) external {
        require(consumer != address(0), "Invalid consumer address");

        // Ensure the consumer is added
        require(consumerToPrimary[consumer] == msg.sender, "Consumer not added");

        delete consumerToPrimary[consumer];
        emit SubscriptionConsumerRemoved(msg.sender, consumer);
    }

    function requestCrossChainSwap(
        address token,
        uint256 amount,
        uint256 fee,
        uint256 dstChainId,
        address creator,
        bytes calldata signature
    ) external nonReentrant onlyOwner returns (bytes32 requestId) {
        // Validate the BLS signature
        uint256 nonce = ++currentNonce;
        (, bytes memory messageAsG1Bytes,) = crossChainTransferParamsToBytes(token, amount, fee, dstChainId, creator, nonce);
        require(
            blsValidator.verifySignature(messageAsG1Bytes, signature, blsValidator.getPublicKeyBytes()),
            "Invalid BLS signature"
        );
        require(amount > 0, "Amount must be greater than zero");
        require(creator != address(0), "Invalid recipient address");

        // Approve the token transfer if not already approved
        // todo - map creator to accepted token to recipient to destination chain id for full validation
        address acceptedToken = creatorToAcceptedToken[creator];
        // Ensure the token is accepted by the creator
        require(token == acceptedToken, "Token not accepted by creator");
        if (IERC20(token).allowance(address(this), address(router)) < amount) {
            IERC20(token).approve(address(router), amount);
        }
        // Ensure the contract has enough balance to cover the swap
        require(IERC20(token).balanceOf(address(this)) >= amount, "Insufficient token balance");
        // Ensure the destination chain ID is valid
        require(dstChainId > 0, "Invalid destination chain ID");
        // Ensure the fee is non-zero
        require(fee > 0, "Fee must be greater than zero");

        // Transfer the specified amount of tokens from the contract to the router
        IERC20(token).safeTransferFrom(address(this), address(router), amount);

        // Call the router function to initiate the cross-chain swap
        requestId = router.requestCrossChainSwap(token, amount, fee, dstChainId, creator);

        emit CrossChainSwapRequested(msg.sender, token, amount, fee, getChainID(), dstChainId, creator);
    }

    function crossChainTransferParamsToBytes(
        address token,
        uint256 amount,
        uint256 fee,
        uint256 dstChainId,
        address creator,
        uint256 nextNonce
    ) public view returns (bytes memory message, bytes memory messageAsG1Bytes, BLS.PointG1 memory messageAsG1Point) {
        message = abi.encode(token, amount, fee, dstChainId, creator, getChainID(), blsValidator.SCHEME_ID(), nextNonce);
        (uint256 x, uint256 y) = blsValidator.hashToPoint(message);
        messageAsG1Point = BLS.PointG1({x: x, y: y});
        messageAsG1Bytes = blsValidator.hashToBytes(message);
    }

    function isSubscribed(address creator, address user) external view returns (bool) {
        bytes32 subCode = userSubscriptions[user][creator];
        return subCode != bytes32(0);
    }

    function getSubscription(address creator, address user) external view returns (bytes32) {
        return userSubscriptions[user][creator];
    }

    function getSubscriptionBalance(address user, address token) external view returns (uint256) {
        return userTokenBalances[user][token];
    }

    function getAcceptedToken(address creator) external view returns (address) {
        return creatorToAcceptedToken[creator];
    }

    function getCreatorBalance(address creator, address token) external view returns (uint256) {
        return creatorBalances[creator][token];
    }

    function getConsumerPrimary(address consumer) external view returns (address) {
        return consumerToPrimary[consumer];
    }

    function getUserSubscriptionCode(address user, address creator) external view returns (bytes32) {
        return userSubscriptions[user][creator];
    }

    /// @notice Returns the current EVM chain ID
    function getChainID() public view returns (uint256) {
        return block.chainid;
    }
}
