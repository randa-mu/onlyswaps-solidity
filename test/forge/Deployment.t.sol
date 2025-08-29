// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Test} from "forge-std/Test.sol";
import {BLS} from "bls-solidity-0.1.0/BLS.sol";

import {Router} from "../../src/Router.sol";
import {BN254SignatureScheme} from "../../src/signature-scheme/BN254SignatureScheme.sol";
import {ERC20Token} from "../../src/mocks/ERC20Token.sol";

contract DeploymentTest is Test {
    Router public srcRouter;
    Router public dstRouter;
    ERC20Token public srcToken;
    ERC20Token public dstToken;
    BN254SignatureScheme public srcBLSSigVerifier;
    BN254SignatureScheme public dstBLSSigVerifier;

    uint256 srcChainId = 1;
    uint256 dstChainId = 31337;

    bytes internal validPK =
        hex"204a5468e6d01b87c07655eebbb1d43913e197f53281a7d56e2b1a0beac194aa00899f6a3998ecb2f832d35025bf38bef7429005e6b591d9e0ffb10078409f220a6758eec538bb8a511eed78c922a213e4cc06743aeb10ed77f63416fe964c3505d04df1d2daeefa07790b41a9e0ab762e264798bc36340dc3a0cc5654cefa4b";

    address internal owner;

    function setUp() public {
        owner = makeAddr("owner");

        BLS.PointG2 memory pk = abi.decode(validPK, (BLS.PointG2));

        uint8 tokenDecimals = 18;

        /// @dev src chain deployment
        /// for each chain, we deploy the following contracts
        srcBLSSigVerifier = new BN254SignatureScheme([pk.x[1], pk.x[0]], [pk.y[1], pk.y[0]]);
        srcToken = new ERC20Token("Source Token", "ST", tokenDecimals);
        srcRouter = new Router(owner, address(srcBLSSigVerifier));

        /// @dev dst chain deployment
        dstBLSSigVerifier = new BN254SignatureScheme([pk.x[1], pk.x[0]], [pk.y[1], pk.y[0]]);
        dstToken = new ERC20Token("Destination Token", "DT", tokenDecimals);
        dstRouter = new Router(owner, address(dstBLSSigVerifier));

        /// @dev configurations
        /// whitelist requests to specific destination chain ids
        vm.prank(owner);
        srcRouter.permitDestinationChainId(dstChainId);

        vm.prank(owner);
        dstRouter.permitDestinationChainId(srcChainId);

        /// map token on each src chain to a token on the dst chain
        vm.prank(owner);
        srcRouter.setTokenMapping(dstChainId, address(dstToken), address(srcToken));

        vm.prank(owner);
        dstRouter.setTokenMapping(srcChainId, address(srcToken), address(dstToken));
    }

    function test_GetAllowedSrcChainIds() public view {
        assertEq(srcRouter.getAllowedDstChainId(dstChainId), true);
        assertEq(dstRouter.getAllowedDstChainId(srcChainId), true);
    }

    function test_ConstructorArguments() public view {
        assertEq(srcRouter.getBlsValidator(), address(srcBLSSigVerifier));
        assertEq(dstRouter.getBlsValidator(), address(dstBLSSigVerifier));
        assertEq(srcRouter.owner(), owner);
        assertEq(dstRouter.owner(), owner);
    }
}
