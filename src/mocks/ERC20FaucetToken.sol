// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ERC20 token with faucet functionality.
/// @dev Users can mint a limited amount once every 24 hours.
contract ERC20FaucetToken is ERC20, ERC20Permit, ERC20Votes, Ownable {
    uint8 private _decimals;
    uint256 public faucetAmount;
    uint256 public constant FAUCET_INTERVAL = 1 days;

    mapping(address => uint256) public lastMint;

    event FaucetAmountSet(uint256 faucetAmount);

    constructor(string memory name, string memory symbol, uint8 decimals_, uint256 faucetAmount_, address _owner)
        ERC20(name, symbol)
        ERC20Permit(name)
        Ownable(_owner)
    {
        _decimals = decimals_;
        faucetAmount = faucetAmount_;
    }

    /// @notice Allows users to mint tokens once every 24 hours.
    function mint() external {
        require(block.timestamp >= lastMint[msg.sender] + FAUCET_INTERVAL, "Faucet: Wait 24h between mints");

        lastMint[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
    }

    function setFaucetAmount(uint256 faucetAmount_) external onlyOwner {
        faucetAmount = faucetAmount_;
        emit FaucetAmountSet(faucetAmount);
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
