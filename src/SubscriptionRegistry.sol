// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SubscriptionRegistry is Ownable {
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

    // creator => accepted token
    mapping(address => IERC20) public acceptedTokens;

    mapping(address => mapping(uint256 => Tier)) public tiers; // creator => tierId => Tier
    mapping(address => uint256) public tierCount; // creator => tier count

    mapping(address => mapping(address => Subscription)) public subscriptions; // subscriber => creator => Subscription
    mapping(address => mapping(address => bool)) public consumers; // primary => consumer
    mapping(address => mapping(address => address)) public consumerToPrimary; // consumer => creator => primary

    event TierSet(address indexed creator, uint256 indexed tierId, uint256 price, uint256 duration);
    event TierUpdated(address indexed creator, uint256 indexed tierId, uint256 price, uint256 duration);
    event TierRemoved(address indexed creator, uint256 indexed tierId);
    event Subscribed(address indexed subscriber, address indexed creator, uint256 indexed tierId, uint256 expiresAt);
    event ConsumerAdded(address indexed primary, address indexed consumer, address indexed creator);
    event ConsumerRemoved(address indexed primary, address indexed consumer, address indexed creator);
    event PaymentTransferred(address indexed from, address indexed to, uint256 amount, address token);
    event AcceptedTokenSet(address indexed creator, address indexed token);

    /// @param _owner Initial contract owner
    constructor(address _owner) Ownable(_owner) {}

    function setAcceptedToken(address token) external {
        require(token != address(0), "Invalid token");
        acceptedTokens[msg.sender] = IERC20(token);
        emit AcceptedTokenSet(msg.sender, token);
    }

    function _collectPayment(address from, address to, uint256 amount, IERC20 token) internal {
        token.safeTransferFrom(from, to, amount);
        emit PaymentTransferred(from, to, amount, address(token));
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

    function createSubscription(address creator, uint256 tierId) external {
        Tier memory tier = tiers[creator][tierId];
        require(tier.duration > 0 && tier.active, "Invalid or inactive tier");
        IERC20 token = acceptedTokens[creator];
        require(address(token) != address(0), "No accepted token");
        _collectPayment(msg.sender, creator, tier.price, token);
        uint256 expiresAt = block.timestamp + tier.duration;
        subscriptions[msg.sender][creator] = Subscription(tierId, expiresAt);
        emit Subscribed(msg.sender, creator, tierId, expiresAt);
    }

    function directSubscribe(address creator, uint256 tierId) external {
        Tier memory tier = tiers[creator][tierId];
        require(tier.duration > 0 && tier.active, "Invalid or inactive tier");
        IERC20 token = acceptedTokens[creator];
        require(address(token) != address(0), "No accepted token");
        _collectPayment(msg.sender, creator, tier.price, token);
        uint256 expiresAt = block.timestamp + tier.duration;
        subscriptions[msg.sender][creator] = Subscription(tierId, expiresAt);
        emit Subscribed(msg.sender, creator, tierId, expiresAt);
    }

    function renewSubscription(address creator) external {
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

    /// @dev todo We can have role based access control to have only whitelisted dcipher nodes call this function
    /// @notice Completes a cross-chain subscription by applying delivered funds to a subscription tier
    /// @param subscriber The user who initiated the subscription on source chain
    /// @param creator The creator receiving the subscription
    /// @param tierId The tier being subscribed to
    /// @param amount Amount of tokens bridged and received
    /// @param token The token used for payment
    function completeCrossChainSubscription(
        address subscriber,
        address creator,
        uint256 tierId,
        uint256 amount,
        address token
    ) external onlyOwner {
        Tier memory tier = tiers[creator][tierId];
        require(tier.duration > 0 && tier.active, "Invalid or inactive tier");
        require(amount >= tier.price, "Insufficient payment");
        require(token == address(acceptedTokens[creator]), "Wrong token");

        uint256 expiresAt = block.timestamp + tier.duration;
        subscriptions[subscriber][creator] = Subscription(tierId, expiresAt);

        require(IERC20(token).transfer(creator, amount), "Payment transfer failed");

        emit PaymentTransferred(subscriber, creator, amount, token);
        emit Subscribed(subscriber, creator, tierId, expiresAt);
    }
}
