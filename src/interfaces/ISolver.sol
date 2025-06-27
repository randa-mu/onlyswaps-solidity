// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

interface ISolver {
    /// @notice Called by the solver on the destination chain to fulfill a user's transfer
    function deliverTokens(
        bytes32 intentId,
        address tokenOut, // address of token sent to dstRecipient on destination chain
        uint256 amountOut,
        address dstRecipient
    ) external;

    /// @notice View fulfilled deliveries
    function isFulfilled(bytes32 intentId) external view returns (bool);
}
