// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @title ERC20 token mock.
/// @dev A generic ERC20 token mock that can mint and burn tokens, used for testing only.
/// @dev Inspired by OpenZeppelin's "How to set up on-chain governance" guide: https://docs.openzeppelin.com/contracts/5.x/governance#token
contract ERC20Token is ERC20, ERC20Permit, ERC20Votes {
    uint8 private _decimals;

    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) ERC20Permit(name) {
        _decimals = decimals_;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) external {
        _burn(account, amount);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // The functions below are overrides required by Solidity.

    function _update(address from, address to, uint256 amount) internal override (ERC20, ERC20Votes) {
        super._update(from, to, amount);
    }

    function nonces(address owner) public view virtual override (ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
