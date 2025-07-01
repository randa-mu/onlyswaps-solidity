// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

contract Bridge {
    struct TransferReceipt {
        bytes32 requestId; // Reference to the original request on the src chain
        bool fulfilled; // Whether the transfer has been delivered
        address solver; // Who fulfilled it
        uint256 amountOut; // The amount delivered
        uint256 fulfilledAt; // Timestamp of delivery
    }

    event BridgeReceipt( // Reference to the original intent
        // Whether the transfer was delivered
        // Who fulfilled it
        // Final amount delivered
        // Timestamp of delivery
    bytes32 requestId, bool fulfilled, address solver, uint256 amountOut, uint256 fulfilledAt);

    // todo map receipt to each token release to recipient
    // todo optionally add bytes32 bridgeRequestId from src chain, but no means to validate on dst chain bridge contract
    // just for accounting to track is fulfilled on dst chain
    function relayTokens(address token, address recipient, uint256 amount) external {
        // we can optionally communicate back to router contract on src chain using layerzero to inform of the payment and withdraw funds + fees if no other
        // solver has fulfilled
    }

    /// @notice View fulfilled deliveries
    function isFulfilled(bytes32 bridgeRequestId) external view returns (bool) {}
}
