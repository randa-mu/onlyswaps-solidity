// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IBridge} from "./interfaces/IBridge.sol";

contract Bridge is Ownable, IBridge {
    using SafeERC20 for IERC20;

    /// @dev Mapping of requestId to transfer receipt
    mapping(bytes32 => TransferReceipt) public receipts;

    constructor(address owner) Ownable(owner) {}

    /// @notice Relays tokens to the recipient and stores a receipt
    /// @param token The token being relayed
    /// @param recipient The target recipient of the tokens
    /// @param amount The net amount delivered (after fees)
    /// @param requestId The original request ID from the source chain
    /// @param srcChainId The ID of the source chain where the request originated
    function relayTokens(address token, address recipient, uint256 amount, bytes32 requestId, uint256 srcChainId)
        external
    {
        require(!receipts[requestId].fulfilled, "Already fulfilled");
        require(token != address(0) && recipient != address(0), "Invalid token or recipient");
        require(amount > 0, "Zero amount");

        IERC20(token).safeTransfer(recipient, amount);

        receipts[requestId] = TransferReceipt({
            requestId: requestId,
            srcChainId: srcChainId,
            fulfilled: true,
            solver: msg.sender,
            amountOut: amount,
            fulfilledAt: block.timestamp
        });

        emit BridgeReceipt(requestId, srcChainId, true, msg.sender, amount, block.timestamp);
    }

    /// @notice Checks whether a bridge request has been fulfilled
    /// @param bridgeRequestId The request ID to check
    /// @return True if fulfilled, false otherwise
    function isFulfilled(bytes32 bridgeRequestId) external view returns (bool) {
        return receipts[bridgeRequestId].fulfilled;
    }

    /// @notice Allows owner to recover tokens mistakenly sent to the contract
    /// @param token The ERC20 token to rescue
    /// @param to The address to send rescued tokens to
    /// @param amount The amount of tokens to rescue
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0) && to != address(0), "Invalid address");
        IERC20(token).safeTransfer(to, amount);
    }
}
