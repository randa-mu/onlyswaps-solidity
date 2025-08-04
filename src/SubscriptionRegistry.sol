// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SubscriptionRegistry
/// @notice This contract manages subscriptions to creators, allowing users to subscribe to different tiers.
contract SubscriptionRegistry is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Tier {
        uint256 price;
        uint256 duration;
        bool active;
    }

    struct Subscription {
        uint256 tierId;
        uint256 expiresAt;
    }

    mapping(address => IERC20) public acceptedTokens;
    mapping(address => mapping(uint256 => Tier)) public tiers;
    mapping(address => uint256) public tierCount;

    mapping(address => mapping(address => Subscription)) public subscriptions;
    mapping(address => mapping(address => bool)) public consumers;
    mapping(address => mapping(address => address)) public consumerToPrimary;

    mapping(address => mapping(address => uint256)) public subscriptionBalances;

    event TierSet(address indexed creator, uint256 indexed tierId, uint256 price, uint256 duration);
    event TierUpdated(address indexed creator, uint256 indexed tierId, uint256 price, uint256 duration);
    event TierRemoved(address indexed creator, uint256 indexed tierId);
    event Subscribed(address indexed subscriber, address indexed creator, uint256 indexed tierId, uint256 expiresAt);
    event ConsumerAdded(address indexed primary, address indexed consumer, address indexed creator);
    event ConsumerRemoved(address indexed primary, address indexed consumer, address indexed creator);
    event PaymentTransferred(address indexed from, address indexed to, uint256 amount, address token);
    event AcceptedTokenSet(address indexed creator, address indexed token);
    event SubscriptionCancelled(address indexed subscriber, address indexed creator);
    event BalanceFunded(address indexed subscriber, address indexed creator, uint256 amount, address token);
    event SubscriptionAutoRenewed(
        address indexed subscriber, address indexed creator, uint256 tierId, uint256 expiresAt
    );

    constructor(address _owner) Ownable(_owner) {}

    // ----------------------------------------------------
    // Internal
    // ----------------------------------------------------
    function _collectPayment(address from, address to, uint256 amount, IERC20 token) internal {
        token.safeTransferFrom(from, to, amount);
        emit PaymentTransferred(from, to, amount, address(token));
    }

    // ----------------------------------------------------
    // External - User or Creator
    // ----------------------------------------------------

    function setAcceptedToken(address token) external {
        require(token != address(0), "Invalid token");
        acceptedTokens[msg.sender] = IERC20(token);
        emit AcceptedTokenSet(msg.sender, token);
    }

    function setTier(uint256 price, uint256 duration) external {
        require(duration > 0, "Invalid duration");
        uint256 tierId = tierCount[msg.sender]++;
        tiers[msg.sender][tierId] = Tier(price, duration, true);
        emit TierSet(msg.sender, tierId, price, duration);
    }

    function updateTier(uint256 tierId, uint256 newPrice, uint256 newDuration) external {
        Tier storage tier = tiers[msg.sender][tierId];
        require(tier.duration > 0, "Tier does not exist");
        tier.price = newPrice;
        tier.duration = newDuration;
        emit TierUpdated(msg.sender, tierId, newPrice, newDuration);
    }

    function removeTier(uint256 tierId) external {
        Tier storage tier = tiers[msg.sender][tierId];
        require(tier.duration > 0, "Tier does not exist");
        tier.active = false;
        emit TierRemoved(msg.sender, tierId);
    }

    function createSubscription(address creator, uint256 tierId) external nonReentrant {
        Tier memory tier = tiers[creator][tierId];
        require(tier.duration > 0 && tier.active, "Invalid or inactive tier");

        Subscription memory existingSub = subscriptions[msg.sender][creator];
        require(existingSub.expiresAt < block.timestamp, "Already subscribed");

        IERC20 token = acceptedTokens[creator];
        require(address(token) != address(0), "No accepted token");

        _collectPayment(msg.sender, creator, tier.price, token);
        uint256 expiresAt = block.timestamp + tier.duration;
        subscriptions[msg.sender][creator] = Subscription(tierId, expiresAt);
        emit Subscribed(msg.sender, creator, tierId, expiresAt);
    }

    function fundSubscriptionBalance(address creator, uint256 amount) external nonReentrant {
        IERC20 token = acceptedTokens[creator];
        require(address(token) != address(0), "No accepted token");

        token.safeTransferFrom(msg.sender, address(this), amount);
        subscriptionBalances[msg.sender][creator] += amount;

        emit BalanceFunded(msg.sender, creator, amount, address(token));
    }

    function renewSubscription(address creator) external nonReentrant {
        Subscription storage sub = subscriptions[msg.sender][creator];
        Tier memory tier = tiers[creator][sub.tierId];
        require(tier.duration > 0 && tier.active, "Invalid or inactive tier");
        require(sub.expiresAt >= block.timestamp, "Subscription expired");

        IERC20 token = acceptedTokens[creator];
        require(address(token) != address(0), "No accepted token");

        _collectPayment(msg.sender, creator, tier.price, token);
        sub.expiresAt += tier.duration;

        emit Subscribed(msg.sender, creator, sub.tierId, sub.expiresAt);
    }

    function cancelSubscription(address creator) external {
        delete subscriptions[msg.sender][creator];
        emit SubscriptionCancelled(msg.sender, creator);
    }

    function autoRenewFromBalance(address subscriber, address creator) external nonReentrant {
        Subscription storage sub = subscriptions[subscriber][creator];
        require(sub.expiresAt >= block.timestamp, "Subscription expired");

        Tier memory tier = tiers[creator][sub.tierId];
        require(tier.duration > 0 && tier.active, "Invalid tier");

        uint256 balance = subscriptionBalances[subscriber][creator];
        require(balance >= tier.price, "Insufficient balance");

        subscriptionBalances[subscriber][creator] -= tier.price;
        sub.expiresAt += tier.duration;

        IERC20 token = acceptedTokens[creator];
        require(address(token) != address(0), "No accepted token");
        token.safeTransfer(creator, tier.price);

        emit SubscriptionAutoRenewed(subscriber, creator, sub.tierId, sub.expiresAt);
    }

    function addConsumer(address creator, address consumer) external {
        require(subscriptions[msg.sender][creator].expiresAt >= block.timestamp, "Not subscribed");
        consumers[msg.sender][consumer] = true;
        consumerToPrimary[consumer][creator] = msg.sender;
        emit ConsumerAdded(msg.sender, consumer, creator);
    }

    function removeConsumer(address creator, address consumer) external {
        require(consumers[msg.sender][consumer], "Not a consumer");
        delete consumers[msg.sender][consumer];
        delete consumerToPrimary[consumer][creator];
        emit ConsumerRemoved(msg.sender, consumer, creator);
    }

    function isSubscribed(address creator, address user) public view returns (bool) {
        Subscription memory directSub = subscriptions[user][creator];
        if (directSub.expiresAt >= block.timestamp) return true;

        address primary = consumerToPrimary[user][creator];
        if (primary != address(0)) {
            Subscription memory sharedSub = subscriptions[primary][creator];
            return sharedSub.expiresAt >= block.timestamp;
        }

        return false;
    }

    function getTier(address creator, uint256 tierId) external view returns (Tier memory) {
        return tiers[creator][tierId];
    }

    function getSubscription(address subscriber, address creator) external view returns (Subscription memory) {
        return subscriptions[subscriber][creator];
    }

    // ----------------------------------------------------
    // Cross-Chain Functions (Only Owner/Relayer)
    // ----------------------------------------------------

    function completeCrossChainSubscription(
        address subscriber,
        address creator,
        uint256 tierId,
        uint256 amount,
        address token
    ) external onlyOwner nonReentrant {
        Tier memory tier = tiers[creator][tierId];
        require(tier.duration > 0 && tier.active, "Invalid or inactive tier");
        require(amount >= tier.price, "Insufficient payment");
        require(token == address(acceptedTokens[creator]), "Wrong token");

        Subscription memory existingSub = subscriptions[subscriber][creator];
        require(existingSub.expiresAt < block.timestamp, "Active subscription exists");

        uint256 expiresAt = block.timestamp + tier.duration;
        subscriptions[subscriber][creator] = Subscription(tierId, expiresAt);

        require(IERC20(token).transfer(creator, amount), "Payment transfer failed");

        emit PaymentTransferred(subscriber, creator, amount, token);
        emit Subscribed(subscriber, creator, tierId, expiresAt);
    }

    function completeCrossChainFundSubscriptionBalance(
        address subscriber,
        address creator,
        uint256 amount,
        address token
    ) external onlyOwner nonReentrant {
        /// @dev This function is used to fund a user's subscription balance for a specific creator.
        /// @dev it is guarded by the owner to ensure only authorized entities can fund balances.
        /// @dev It is typically used in cross-chain scenarios where the owner is a relayer.
        require(token == address(acceptedTokens[creator]), "Wrong token");
        subscriptionBalances[subscriber][creator] += amount;

        emit BalanceFunded(subscriber, creator, amount, token);
    }

    function completeCrossChainRenewSubscription(
        address subscriber,
        address creator,
        uint256 tierId,
        uint256 amount,
        address token
    ) external onlyOwner nonReentrant {
        Subscription storage sub = subscriptions[subscriber][creator];
        Tier memory tier = tiers[creator][tierId];
        require(sub.expiresAt >= block.timestamp, "Not currently subscribed");
        require(tier.duration > 0 && tier.active, "Invalid or inactive tier");
        require(amount >= tier.price, "Insufficient amount");
        require(token == address(acceptedTokens[creator]), "Wrong token");

        require(IERC20(token).transfer(creator, amount), "Payment transfer failed");
        sub.expiresAt += tier.duration;

        emit PaymentTransferred(subscriber, creator, amount, token);
        emit Subscribed(subscriber, creator, tierId, sub.expiresAt);
    }
}
