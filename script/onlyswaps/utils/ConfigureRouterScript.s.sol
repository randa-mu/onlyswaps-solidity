// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {console} from "forge-std/console.sol";

import {EnvReader} from "../../shared/EnvReader.sol";

import {Router} from "src/Router.sol";
import {ERC20} from "src/mocks/ERC20Token.sol";

contract ConfigureRouterScript is EnvReader {
    function run() external {
        // Load values from environment
        address routerSrcAddr = vm.envAddress("ROUTER_SRC_ADDRESS");
        _requireNonZero(routerSrcAddr, "ROUTER_SRC_ADDRESS");

        address erc20SrcAddr = vm.envAddress("ERC20_SRC_ADDRESS");
        _requireNonZero(erc20SrcAddr, "ERC20_SRC_ADDRESS");

        address erc20DstAddr = vm.envAddress("ERC20_DST_ADDRESS");
        _requireNonZero(erc20DstAddr, "ERC20_DST_ADDRESS");

        uint256 dstChainId = vm.envUint("DST_CHAIN_ID");
        _requireValidChainId(dstChainId);

        // Contract instances
        Router routerSrc = Router(payable(routerSrcAddr));
        ERC20 erc20Src = ERC20(erc20SrcAddr);
        ERC20 erc20Dst = ERC20(erc20DstAddr);

        // Call methods
        console.log("Configuring router on chain id:", block.chainid);

        vm.broadcast();
        routerSrc.permitDestinationChainId(dstChainId);

        vm.broadcast();
        routerSrc.setTokenMapping(dstChainId, address(erc20Dst), address(erc20Src));

        console.log("Router configured on chain id:", block.chainid);
    }
}
