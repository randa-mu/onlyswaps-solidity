// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Mock implementation of FilecoinPay for testing purposes.
/// @dev Reference: https://github.com/nijoe1/foc-cross-chain-onboarding/blob/main/contracts/FilecoinPay.sol
contract MockFilecoinPay is EIP712 {
    constructor() EIP712("FilecoinPay", "0.0.1") {}

    bytes32 public constant OPERATOR_APPROVAL_TYPEHASH = keccak256(
        "OperatorApproval(address token,address operator,bool approved,uint256 rateAllowance,uint256 lockupAllowance,uint256 maxLockupPeriod,uint256 nonce,uint256 deadline)"
    );

    mapping(address => uint256) public approvalNonces;

    struct Account {
        uint256 funds;
        uint256 lockupCurrent;
        uint256 lockupRate;
        // epoch up to and including which lockup has been settled for the account
        uint256 lockupLastSettledAt;
    }

    struct OperatorApproval {
        bool isApproved;
        uint256 rateAllowance;
        uint256 lockupAllowance;
        uint256 rateUsage; // Track actual usage for rate
        uint256 lockupUsage; // Track actual usage for lockup
        uint256 maxLockupPeriod; // Maximum lockup period the operator can set for rails created on behalf of the client
    }

    // Counter for generating unique rail IDs
    uint256 private _nextRailId = 1;

    // Internal balances
    // The self-balance collects network fees
    mapping(IERC20 token => mapping(address owner => Account)) public accounts;

    // token => client => operator => Approval
    mapping(IERC20 token => mapping(address client => mapping(address operator => OperatorApproval))) public
        operatorApprovals;

    /// @notice Updates the approval status and allowances for an operator on behalf of the message sender.
    /// @param token The ERC20 token address for which the approval is being set.
    /// @param operator The address of the operator whose approval is being modified.
    /// @param approved Whether the operator is approved (true) or not (false) to create new rails.
    /// @param rateAllowance The maximum payment rate the operator can set across all rails created by the operator on behalf of the message sender. If this is less than the current payment rate, the operator will only be able to reduce rates until they fall below the target.
    /// @param lockupAllowance The maximum amount of funds the operator can lock up on behalf of the message sender towards future payments. If this exceeds the current total amount of funds locked towards future payments, the operator will only be able to reduce future lockup.
    /// @param maxLockupPeriod The maximum number of epochs (blocks) the operator can lock funds for. If this is less than the current lockup period for a rail, the operator will only be able to reduce the lockup period.
    function setOperatorApproval(
        IERC20 token,
        address operator,
        bool approved,
        uint256 rateAllowance,
        uint256 lockupAllowance,
        uint256 maxLockupPeriod
    ) external {
        _setOperatorApproval(token, operator, approved, rateAllowance, lockupAllowance, maxLockupPeriod);
    }

    function _setOperatorApprovalFor(
        IERC20 token,
        address client,
        address operator,
        bool approved,
        uint256 rateAllowance,
        uint256 lockupAllowance,
        uint256 maxLockupPeriod
    ) internal {
        OperatorApproval storage approval = operatorApprovals[token][client][operator];

        approval.isApproved = approved;
        approval.rateAllowance = rateAllowance;
        approval.lockupAllowance = lockupAllowance;
        approval.maxLockupPeriod = maxLockupPeriod;
    }

    // Existing function delegates to new internal function
    function _setOperatorApproval(
        IERC20 token,
        address operator,
        bool approved,
        uint256 rateAllowance,
        uint256 lockupAllowance,
        uint256 maxLockupPeriod
    ) internal {
        _setOperatorApprovalFor(token, msg.sender, operator, approved, rateAllowance, lockupAllowance, maxLockupPeriod);
    }

    function setOperatorApprovalWithSignature(
        IERC20 token,
        address client,
        address operator,
        bool approved,
        uint256 rateAllowance,
        uint256 lockupAllowance,
        uint256 maxLockupPeriod,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp <= deadline, "Expired");

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OPERATOR_APPROVAL_TYPEHASH,
                    address(token),
                    operator,
                    approved,
                    rateAllowance,
                    lockupAllowance,
                    maxLockupPeriod,
                    approvalNonces[client]++,
                    deadline
                )
            )
        );

        require(ECDSA.recover(digest, v, r, s) == client, "Invalid signature");

        _setOperatorApprovalFor(token, client, operator, approved, rateAllowance, lockupAllowance, maxLockupPeriod);
    }

    /// @notice Deposits tokens from the message sender's account into `to`'s account.
    /// @param token The ERC20 token address to deposit.
    /// @param to The address whose account will be credited.
    /// @param amount The amount of tokens to deposit.
    /// @custom:constraint The message sender must have approved this contract to spend the requested amount via the ERC-20 token (`token`).
    function deposit(IERC20 token, address to, uint256 amount) external payable {
        require(msg.value == 0, "Only ERC20 tokens are supported");
        // Transfer tokens from sender to contract
        amount = transferIn(token, msg.sender, amount);

        accounts[token][to].funds += amount;
    }

    /// @notice Withdraws tokens from the caller's account to the caller's account, up to the amount of currently available tokens (the tokens not currently locked in rails).
    /// @param token The ERC20 token address to withdraw.
    /// @param amount The amount of tokens to withdraw.
    function withdraw(IERC20 token, uint256 amount) external {
        return withdrawToInternal(token, msg.sender, amount);
    }

    /// @notice Withdraws tokens (`token`) from the caller's account to `to`, up to the amount of currently available tokens (the tokens not currently locked in rails).
    /// @param token The ERC20 token address to withdraw.
    /// @param to The address to receive the withdrawn tokens.
    /// @param amount The amount of tokens to withdraw.
    function withdrawTo(IERC20 token, address to, uint256 amount) external {
        return withdrawToInternal(token, to, amount);
    }

    function withdrawToInternal(IERC20 token, address to, uint256 amount) internal {
        Account storage account = accounts[token][msg.sender];
        uint256 available = account.funds - account.lockupCurrent;
        require(amount <= available, "Insufficient unlocked funds");
        uint256 actual = transferOut(token, to, amount);
        if (amount != actual) {
            amount = actual;
            require(amount <= available, "Insufficient unlocked funds");
        }
        account.funds -= amount;
    }

    function transferOut(IERC20 token, address to, uint256 amount) internal returns (uint256 actual) {
        // handle fee-on-transfer and hidden-denominator tokens
        uint256 balanceBefore = token.balanceOf(address(this));
        SafeERC20.safeTransfer(token, to, amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        actual = balanceBefore - balanceAfter;
    }

    function transferIn(IERC20 token, address from, uint256 amount) internal returns (uint256 actual) {
        // handle fee-on-transfer and hidden-denominator tokens
        uint256 balanceBefore = token.balanceOf(address(this));
        SafeERC20.safeTransferFrom(token, from, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        actual = balanceAfter - balanceBefore;
    }
}
