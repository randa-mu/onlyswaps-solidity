// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Test} from "forge-std/Test.sol";
import {BLS} from "bls-solidity/BLS.sol";

import {Router} from "../../src/Router.sol";
import {UUPSProxy} from "../../src/proxy/UUPSProxy.sol";
import {BN254SignatureScheme} from "../../src/signature-scheme/BN254SignatureScheme.sol";
import {ERC20Token} from "../../src/mocks/ERC20Token.sol";

/// @title DeploymentTest
/// @notice Test contract for deploying and initializing Router, ERC20Token, and BN254SignatureScheme contracts for source and destination chains.
contract DeploymentTest is Test {
    /// @notice Source chain Router contract
    Router public srcRouter;
    /// @notice Destination chain Router contract
    Router public dstRouter;
    /// @notice Source chain ERC20 token
    ERC20Token public srcToken;
    /// @notice Destination chain ERC20 token
    ERC20Token public dstToken;
    /// @notice Source chain BLS signature verifier for swap requests
    BN254SignatureScheme public srcSwapRequestBLSSigVerifier;
    /// @notice Destination chain BLS signature verifier for swap requests
    BN254SignatureScheme public dstSwapRequestBLSSigVerifier;

    /// @notice Source chain BLS signature verifier for contract upgrades
    BN254SignatureScheme public srcContractUpgradeBLSSigVerifier;
    /// @notice Destination chain BLS signature verifier for contract upgrades
    BN254SignatureScheme public dstContractUpgradeBLSSigVerifier;

    /// @notice Source chain ID
    uint256 srcChainId = 1;
    /// @notice Destination chain ID
    uint256 dstChainId = 31337;

    /// @notice Verification fee in basis points
    uint256 constant VERIFICATION_FEE_BPS = 500;

    /// @notice Valid BLS public key for testing
    bytes internal validPK =
        hex"204a5468e6d01b87c07655eebbb1d43913e197f53281a7d56e2b1a0beac194aa00899f6a3998ecb2f832d35025bf38bef7429005e6b591d9e0ffb10078409f220a6758eec538bb8a511eed78c922a213e4cc06743aeb10ed77f63416fe964c3505d04df1d2daeefa07790b41a9e0ab762e264798bc36340dc3a0cc5654cefa4b";

    /// @notice Owner address used for contract initialization and configuration
    address internal owner;

    /// @notice Deploys and initializes contracts for both source and destination chains
    function setUp() public {
        owner = makeAddr("owner");

        // Decode the BLS public key
        BLS.PointG2 memory pk = abi.decode(validPK, (BLS.PointG2));

        uint8 tokenDecimals = 18;

        /// @dev src chain deployment
        /// Deploy signature verifiers and ERC20 token for the source chain
        srcSwapRequestBLSSigVerifier = new BN254SignatureScheme([pk.x[1], pk.x[0]], [pk.y[1], pk.y[0]], BN254SignatureScheme.ContractType.Bridge);
        srcContractUpgradeBLSSigVerifier = new BN254SignatureScheme([pk.x[1], pk.x[0]], [pk.y[1], pk.y[0]], BN254SignatureScheme.ContractType.Upgrade);
        srcToken = new ERC20Token("Source Token", "ST", tokenDecimals);
        // Deploy upgradable router on src chain
        Router srcRouterImplementation = new Router();
        UUPSProxy srcRouterProxy = new UUPSProxy(address(srcRouterImplementation), "");
        srcRouter = Router(address(srcRouterProxy));
        srcRouter.initialize(
            owner,
            address(srcSwapRequestBLSSigVerifier),
            address(srcContractUpgradeBLSSigVerifier),
            VERIFICATION_FEE_BPS
        );

        /// @dev dst chain deployment
        /// Deploy signature verifiers and ERC20 token for the destination chain
        dstSwapRequestBLSSigVerifier = new BN254SignatureScheme([pk.x[1], pk.x[0]], [pk.y[1], pk.y[0]], BN254SignatureScheme.ContractType.Bridge);
        dstContractUpgradeBLSSigVerifier = new BN254SignatureScheme([pk.x[1], pk.x[0]], [pk.y[1], pk.y[0]], BN254SignatureScheme.ContractType.Upgrade);
        dstToken = new ERC20Token("Destination Token", "DT", tokenDecimals);
        // Deploy upgradable router on dst chain
        Router dstRouterImplementation = new Router();
        UUPSProxy dstRouterProxy = new UUPSProxy(address(dstRouterImplementation), "");
        dstRouter = Router(address(dstRouterProxy));
        dstRouter.initialize(
            owner,
            address(dstSwapRequestBLSSigVerifier),
            address(dstContractUpgradeBLSSigVerifier),
            VERIFICATION_FEE_BPS
        );

        /// @dev configurations
        /// Whitelist requests to specific destination chain ids
        vm.prank(owner);
        srcRouter.permitDestinationChainId(dstChainId);

        vm.prank(owner);
        dstRouter.permitDestinationChainId(srcChainId);

        /// @dev Map token on each src chain to a token on the dst chain
        vm.prank(owner);
        srcRouter.setTokenMapping(dstChainId, address(dstToken), address(srcToken));

        vm.prank(owner);
        dstRouter.setTokenMapping(srcChainId, address(srcToken), address(dstToken));
    }

    /// @notice Test that allowed destination chain IDs are set correctly
    function test_GetAllowedSrcChainIds() public view {
        assertEq(srcRouter.getAllowedDstChainId(dstChainId), true);
        assertEq(dstRouter.getAllowedDstChainId(srcChainId), true);
    }

    /// @notice Test that constructor arguments are set correctly in routers
    function test_ConstructorArguments() public view {
        assertEq(srcRouter.getSwapRequestBlsValidator(), address(srcSwapRequestBLSSigVerifier));
        assertEq(dstRouter.getSwapRequestBlsValidator(), address(dstSwapRequestBLSSigVerifier));
        assertEq(srcRouter.getContractUpgradeBlsValidator(), address(srcContractUpgradeBLSSigVerifier));
        assertEq(dstRouter.getContractUpgradeBlsValidator(), address(dstContractUpgradeBLSSigVerifier));
    }
}
