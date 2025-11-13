// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title MockAaveV3
/// @notice A mock contract simulating Aave V3's supply functionality for testing purposes.
contract MockAaveV3 {
    event Supplied(address asset, uint256 amount, address onBehalfOf, uint16 referralCode);

    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) public virtual {
        require(asset != address(0), "Invalid asset");
        require(amount > 0, "Amount must be > 0");
        require(onBehalfOf != address(0), "Invalid onBehalfOf");
        // Simulate ERC20 transfer
        require(IERC20(asset).transferFrom(msg.sender, address(this), amount), "Transfer failed");
        emit Supplied(asset, amount, onBehalfOf, referralCode);
    }
}
