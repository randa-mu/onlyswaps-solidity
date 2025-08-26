// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Script} from "@forge-std/Script.sol";

abstract contract EnvReader is Script {
    function _requireNonZero(address addr, string memory name) internal pure {
        require(addr != address(0), string.concat(name, " is zero"));
    }

    function _requireValidChainId(uint256 chainId) internal pure {
        require(chainId != 0, "Chain ID is invalid");
    }

    function addressEnvOrDefault(string memory envName, address defaultAddr) internal view returns (address) {
        try vm.envAddress(envName) returns (address env) {
            return env;
        } catch {
            return defaultAddr;
        }
    }

    function loadContractAdminFromEnv() internal view returns (address wallet) {
        wallet = vm.envOr("DEFAULT_CONTRACT_ADMIN", address(0));
        if (wallet == address(0)) {
            uint256 privateKey = vm.envUint("PRIVATE_KEY");
            wallet = vm.addr(privateKey);
        }
    }
}
