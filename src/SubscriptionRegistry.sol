// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

    /// @notice Maps user to creator to subCode
    /// @dev subCode is a unique identifier for the subscription, generated off-chain.
    /// It is expected to be a hash of the user address, creator address, tier ID, and duration.
    /// It is used to identify the subscription and manage its state.
    /// Inactive or closed subscriptions are deleted from storage.
    mapping(address => mapping(address => bytes32)) public userSubscriptions;
    /// @notice Maps user to token balance
    mapping(address => mapping(address => uint256)) public userTokenBalances;
    /// @notice Maps user to creator to accepted token
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

    constructor(address _owner) Ownable(_owner) {}

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

    function requestCrossChainSwap(address token, uint256 amount, uint256 fee, uint256 dstChainId, address recipient)
        external
        onlyOwner
        returns (bytes32 requestId)
    {
        require(amount > 0, "Amount must be greater than zero");
        require(recipient != address(0), "Invalid recipient address");

        // Transfer the specified amount of tokens from the contract to the router
        IERC20(token).safeTransferFrom(address(this), routerAddress, amount);

        // Call the router function to initiate the cross-chain swap
        requestId = router.requestSwap(token, amount, fee, dstChainId, recipient);

        emit CrossChainSwapRequested(msg.sender, token, amount, fee, dstChainId, recipient, requestId);
    }
    
    // // ----------------------------------------------------
    // // Internal
    // // ----------------------------------------------------
    // function _collectPayment(address from, address to, uint256 amount, IERC20 token) internal {
    //     token.safeTransferFrom(from, to, amount);
    //     emit PaymentTransferred(from, to, amount, address(token));
    // }

    // // ----------------------------------------------------
    // // External - User or Creator
    // // ----------------------------------------------------

    // function setAcceptedToken(address token) external {
    //     require(token != address(0), "Invalid token");
    //     acceptedTokens[msg.sender] = IERC20(token);
    //     emit AcceptedTokenSet(msg.sender, token);
    // }

    // function setTier(uint256 price, uint256 duration) external {
    //     require(duration > 0, "Invalid duration");
    //     uint256 tierId = tierCount[msg.sender]++;
    //     tiers[msg.sender][tierId] = Tier(price, duration, true);
    //     emit TierSet(msg.sender, tierId, price, duration);
    // }

    // function updateTier(uint256 tierId, uint256 newPrice, uint256 newDuration) external {
    //     Tier storage tier = tiers[msg.sender][tierId];
    //     require(tier.duration > 0, "Tier does not exist");
    //     tier.price = newPrice;
    //     tier.duration = newDuration;
    //     emit TierUpdated(msg.sender, tierId, newPrice, newDuration);
    // }

    // function removeTier(uint256 tierId) external {
    //     Tier storage tier = tiers[msg.sender][tierId];
    //     require(tier.duration > 0, "Tier does not exist");
    //     tier.active = false;
    //     emit TierRemoved(msg.sender, tierId);
    // }

    // function createSubscription(address creator, uint256 tierId) external nonReentrant {
    //     Tier memory tier = tiers[creator][tierId];
    //     require(tier.duration > 0 && tier.active, "Invalid or inactive tier");

    //     Subscription memory existingSub = subscriptions[msg.sender][creator];
    //     require(existingSub.expiresAt < block.timestamp, "Already subscribed");

    //     IERC20 token = acceptedTokens[creator];
    //     require(address(token) != address(0), "No accepted token");

    //     _collectPayment(msg.sender, creator, tier.price, token);
    //     uint256 expiresAt = block.timestamp + tier.duration;
    //     subscriptions[msg.sender][creator] = Subscription(tierId, expiresAt);
    //     emit Subscribed(msg.sender, creator, tierId, expiresAt);
    // }

    // function fundSubscriptionBalance(address creator, uint256 amount) external nonReentrant {
    //     IERC20 token = acceptedTokens[creator];
    //     require(address(token) != address(0), "No accepted token");

    //     token.safeTransferFrom(msg.sender, address(this), amount);
    //     subscriptionBalances[msg.sender][creator] += amount;

    //     emit BalanceFunded(msg.sender, creator, amount, address(token));
    // }

    // function renewSubscription(address creator) external nonReentrant {
    //     Subscription storage sub = subscriptions[msg.sender][creator];
    //     Tier memory tier = tiers[creator][sub.tierId];
    //     require(tier.duration > 0 && tier.active, "Invalid or inactive tier");
    //     require(sub.expiresAt >= block.timestamp, "Subscription expired");

    //     IERC20 token = acceptedTokens[creator];
    //     require(address(token) != address(0), "No accepted token");

    //     _collectPayment(msg.sender, creator, tier.price, token);
    //     sub.expiresAt += tier.duration;

    //     emit Subscribed(msg.sender, creator, sub.tierId, sub.expiresAt);
    // }

    // function cancelSubscription(address creator) external {
    //     delete subscriptions[msg.sender][creator];
    //     emit SubscriptionCancelled(msg.sender, creator);
    // }

    // function autoRenewFromBalance(address subscriber, address creator) external nonReentrant {
    //     Subscription storage sub = subscriptions[subscriber][creator];
    //     require(sub.expiresAt >= block.timestamp, "Subscription expired");

    //     Tier memory tier = tiers[creator][sub.tierId];
    //     require(tier.duration > 0 && tier.active, "Invalid tier");

    //     uint256 balance = subscriptionBalances[subscriber][creator];
    //     require(balance >= tier.price, "Insufficient balance");

    //     subscriptionBalances[subscriber][creator] -= tier.price;
    //     sub.expiresAt += tier.duration;

    //     IERC20 token = acceptedTokens[creator];
    //     require(address(token) != address(0), "No accepted token");
    //     token.safeTransfer(creator, tier.price);

    //     emit SubscriptionAutoRenewed(subscriber, creator, sub.tierId, sub.expiresAt);
    // }

    // function addConsumer(address creator, address consumer) external {
    //     require(subscriptions[msg.sender][creator].expiresAt >= block.timestamp, "Not subscribed");
    //     consumers[msg.sender][consumer] = true;
    //     consumerToPrimary[consumer][creator] = msg.sender;
    //     emit ConsumerAdded(msg.sender, consumer, creator);
    // }

    // function removeConsumer(address creator, address consumer) external {
    //     require(consumers[msg.sender][consumer], "Not a consumer");
    //     delete consumers[msg.sender][consumer];
    //     delete consumerToPrimary[consumer][creator];
    //     emit ConsumerRemoved(msg.sender, consumer, creator);
    // }

    // function isSubscribed(address creator, address user) public view returns (bool) {
    //     Subscription memory directSub = subscriptions[user][creator];
    //     if (directSub.expiresAt >= block.timestamp) return true;

    //     address primary = consumerToPrimary[user][creator];
    //     if (primary != address(0)) {
    //         Subscription memory sharedSub = subscriptions[primary][creator];
    //         return sharedSub.expiresAt >= block.timestamp;
    //     }

    //     return false;
    // }

    // function getTier(address creator, uint256 tierId) external view returns (Tier memory) {
    //     return tiers[creator][tierId];
    // }

    // function getSubscription(address subscriber, address creator) external view returns (Subscription memory) {
    //     return subscriptions[subscriber][creator];
    // }

    // // ----------------------------------------------------
    // // Cross-Chain Functions (Only Owner/Relayer)
    // // ----------------------------------------------------

    // function completeCrossChainSubscription(
    //     address subscriber,
    //     address creator,
    //     uint256 tierId,
    //     uint256 amount,
    //     address token
    // ) external onlyOwner nonReentrant {
    //     Tier memory tier = tiers[creator][tierId];
    //     require(tier.duration > 0 && tier.active, "Invalid or inactive tier");
    //     require(amount >= tier.price, "Insufficient payment");
    //     require(token == address(acceptedTokens[creator]), "Wrong token");

    //     Subscription memory existingSub = subscriptions[subscriber][creator];
    //     require(existingSub.expiresAt < block.timestamp, "Active subscription exists");

    //     uint256 expiresAt = block.timestamp + tier.duration;
    //     subscriptions[subscriber][creator] = Subscription(tierId, expiresAt);

    //     require(IERC20(token).transfer(creator, amount), "Payment transfer failed");

    //     emit PaymentTransferred(subscriber, creator, amount, token);
    //     emit Subscribed(subscriber, creator, tierId, expiresAt);
    // }

    // function completeCrossChainFundSubscriptionBalance(
    //     address subscriber,
    //     address creator,
    //     uint256 amount,
    //     address token
    // ) external onlyOwner nonReentrant {
    //     /// @dev This function is used to fund a user's subscription balance for a specific creator.
    //     /// @dev it is guarded by the owner to ensure only authorized entities can fund balances.
    //     /// @dev It is typically used in cross-chain scenarios where the owner is a relayer.
    //     require(token == address(acceptedTokens[creator]), "Wrong token");
    //     subscriptionBalances[subscriber][creator] += amount;

    //     emit BalanceFunded(subscriber, creator, amount, token);
    // }

    // function completeCrossChainRenewSubscription(
    //     address subscriber,
    //     address creator,
    //     uint256 tierId,
    //     uint256 amount,
    //     address token
    // ) external onlyOwner nonReentrant {
    //     Subscription storage sub = subscriptions[subscriber][creator];
    //     Tier memory tier = tiers[creator][tierId];
    //     require(sub.expiresAt >= block.timestamp, "Not currently subscribed");
    //     require(tier.duration > 0 && tier.active, "Invalid or inactive tier");
    //     require(amount >= tier.price, "Insufficient amount");
    //     require(token == address(acceptedTokens[creator]), "Wrong token");

    //     require(IERC20(token).transfer(creator, amount), "Payment transfer failed");
    //     sub.expiresAt += tier.duration;

    //     emit PaymentTransferred(subscriber, creator, amount, token);
    //     emit Subscribed(subscriber, creator, tierId, sub.expiresAt);
    // }
}
