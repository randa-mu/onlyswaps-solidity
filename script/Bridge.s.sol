// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {BN254SignatureScheme} from "../src/signature-scheme/BN254SignatureScheme.sol";
import {BLS} from "../src/libraries/BLS.sol";

import {ERC20Token} from "../src/mocks/ERC20Token.sol";
import {Router} from "../src/Router.sol";
import {Bridge} from "../src/Bridge.sol";

contract BridgeScript is Script {
    bytes32 constant SALT = bytes32(uint256(1));

    BLS.PointG2 blsPublicKey = BLS.PointG2({
        x: [vm.envUint("BLS_PUBLIC_KEY_X0"), vm.envUint("BLS_PUBLIC_KEY_X1")],
        y: [vm.envUint("BLS_PUBLIC_KEY_Y0"), vm.envUint("BLS_PUBLIC_KEY_Y1")]
    });

    function run() public virtual {
        // Load the deployer's private key from .env
        uint256 privateKey = vm.envUint("PRIVATE_KEY");

        address wallet = vm.addr(privateKey);

        // Deploy BN254 signature scheme and verifier contract
        BN254SignatureScheme bn254SignatureScheme = deployBN254SignatureScheme();
        // Deploy source token
        ERC20Token token = deployMockToken();
        // Deploy Bridge contract
        deployBridge(wallet);
        // Deploy Router contract
        deployRouter(wallet, address(bn254SignatureScheme));
    }

    function deployBN254SignatureScheme() internal returns (BN254SignatureScheme bn254SignatureScheme) {
        vm.broadcast();
        bn254SignatureScheme = new BN254SignatureScheme{salt: SALT}(blsPublicKey.x, blsPublicKey.y);
        console.log("Bn254SignatureScheme contract deployed at: ", address(bn254SignatureScheme));
    }

    function deployMockToken() internal returns (ERC20Token token) {
        vm.broadcast();
        uint8 tokenDecimals = 18;
        token = new ERC20Token{salt: SALT}("MockPolygonUSDC", "MPUSDC", tokenDecimals);
        console.log("Mock Polygon USDC contract deployed at: ", address(token));
    }

    function deployBridge(address owner) internal returns (Bridge bridge) {
        vm.broadcast();
        bridge = new Bridge{salt: SALT}(owner);
        console.log("Bridge contract deployed at: ", address(bridge));
    }

    function deployRouter(address owner, address bLSSigVerifier) internal returns (Router router) {
        vm.broadcast();
        router = new Router{salt: SALT}(owner, bLSSigVerifier);
        console.log("Router contract deployed at: ", address(router));
    }
}
