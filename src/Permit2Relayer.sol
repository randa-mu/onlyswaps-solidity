// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPermit2} from "uniswap-permit2/interfaces/IPermit2.sol";
import {ISignatureTransfer} from "uniswap-permit2/interfaces/ISignatureTransfer.sol";

/// @title A simple contract that takes care of withdrawing and forwarding tokens, at most once
/// @author Randamu
/// @notice This contract facilitates cross-chain token swaps with fee management and BLS signature verification.
contract Permit2Relayer {
    using SafeERC20 for IERC20;

    /// @notice The address of the canonical Permit2 contract
    IPermit2 public PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    /// @notice Type name of the custom witness
    string constant WITNESS_TYPE_NAME = "RelayerWitness";

    /// @notice Type string of the custom witness
    string constant WITNESS_TYPE_STRING =
        string(abi.encodePacked(WITNESS_TYPE_NAME, "(bytes32 requestId,address recipient,bytes additionalData)"));

    /// @notice Type hash used to compute the witness hash
    bytes32 constant WITNESS_TYPE_HASH = keccak256(bytes(WITNESS_TYPE_STRING));

    /// @notice The permit2 witnessTypeString parameter,
    string constant PERMIT2_WITNESS_TYPE_STRING = string(
        abi.encodePacked(
            WITNESS_TYPE_NAME, " witness)", WITNESS_TYPE_STRING, "TokenPermissions(address token,uint256 amount)"
        )
    );

    /// @notice Mapping to store which identifiers have been used. This ensures that a permit can be used at most once.
    mapping(bytes32 => bool) public usedRelayTokensIdentifiers;

    /// @notice Relays tokens to a recipient at most once per request identifier
    /// @param requestId A unique request ID
    /// @param signer The address of the signer approving the transfer
    /// @param recipient The address to receive the tokens
    /// @param additionalData Extra information that was signed alongside the permit
    /// @param permit The Permit2 permit data
    /// @param signature The signature for the permit
    function relayTokensPermit2(
        bytes32 requestId,
        address signer,
        address recipient,
        bytes calldata additionalData,
        IPermit2.PermitTransferFrom memory permit,
        bytes calldata signature
    ) external {
        // revert if request id has already been used
        // this ensures that at most a _single_ permit containing the requestId
        // can be consumed by that contract.
        require(!usedRelayTokensIdentifiers[requestId], "TokenRelayer: Identifier already used");

        IPermit2.SignatureTransferDetails memory transferDetails = ISignatureTransfer.SignatureTransferDetails({
            to: address(this),
            // we require the permit amount to be the same as the requested amount
            requestedAmount: permit.permitted.amount
        });

        // By computing the witness here, we ensure that the permit was approved for that request id specifically.
        // That same reasoning cannot be applied to the additionalData as it is controlled by the caller entirely.
        bytes32 witness = keccak256(abi.encode(WITNESS_TYPE_HASH, requestId, recipient, keccak256(additionalData)));

        PERMIT2.permitWitnessTransferFrom(
            permit, transferDetails, signer, witness, PERMIT2_WITNESS_TYPE_STRING, signature
        );

        IERC20(permit.permitted.token).safeTransfer(recipient, permit.permitted.amount);
    }

    function requestCrossChainSwapPermit2(
        address router,
        address signer,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        uint256 solverFee,
        uint256 dstChainId,
        address recipient,
        IPermit2.PermitTransferFrom memory permit,
        bytes calldata signature,
        bytes calldata additionalData
    ) external {
        /// @notice Type string of the custom witness
        string memory WITNESS_TYPE_STRING = string(
            abi.encodePacked(
                WITNESS_TYPE_NAME,
                "(address router,address tokenIn,address tokenOut,uint256 amount,uint256 solverFee,uint256 dstChainId,address recipient,bytes additionalData)"
            )
        );

        /// @notice Type hash used to compute the witness hash
        bytes32 WITNESS_TYPE_HASH = keccak256(bytes(WITNESS_TYPE_STRING));

        /// @notice The permit2 witnessTypeString parameter,
        string memory PERMIT2_WITNESS_TYPE_STRING = string(
            abi.encodePacked(
                WITNESS_TYPE_NAME, " witness)", WITNESS_TYPE_STRING, "TokenPermissions(address token,uint256 amount)"
            )
        );

        IPermit2.SignatureTransferDetails memory transferDetails = ISignatureTransfer.SignatureTransferDetails({
            to: address(this),
            // we require the permit amount to be the same as the requested amount
            requestedAmount: permit.permitted.amount
        });

        // By computing the witness here, we ensure that the permit was approved for that request id specifically.
        // That same reasoning cannot be applied to the additionalData as it is controlled by the caller entirely.
        bytes32 witness = keccak256(
            abi.encode(
                WITNESS_TYPE_HASH,
                router,
                tokenIn,
                tokenOut,
                amount,
                solverFee,
                dstChainId,
                recipient,
                keccak256(additionalData)
            )
        );

        // Consume the permit
        // No need to track used identifiers here as the Router will do that
        // and this function only forwards tokens to it.
        // The Router will then ensure that each request id is used at most once.
        PERMIT2.permitWitnessTransferFrom(
            permit, transferDetails, signer, witness, PERMIT2_WITNESS_TYPE_STRING, signature
        );
        // Forward the tokens to the Router
        // The Router will handle the rest of the request logic
        IERC20(permit.permitted.token).safeTransfer(router, permit.permitted.amount);
    }

    /// @notice Sets the Permit2 contract address
    /// @dev TODO: This function is used for testing purposes only
    function setPermit2Address(address permit2Address) external {
        PERMIT2 = IPermit2(permit2Address);
    }
}
