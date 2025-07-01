// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {BLS} from "./libraries/BLS.sol";

import {ISignatureScheme} from "./interfaces/ISignatureScheme.sol";
import {ISettlement} from "./interfaces/ISettlement.sol";

contract Router is Ownable {
    struct TransferParams {
        address sender;
        address recipient;
        address token;
        uint256 amount;
        uint256 srcChainId;
        uint256 dstChainId;
        uint256 nonce;
    }

    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    enum TransferStatus {
        None,
        Requested,
        Executed
    }

    uint256 public constant BPS_DIVISOR = 10_000;

    uint256 public bridgeFeeBps = 500;
    uint256 public solverFeeBps = 500;
    uint256 public constant MAX_FEE_BPS = 5000;

    uint256 public immutable thisChainId;

    /// @dev Set for storing unique unfulfilled transfer request Ids
    EnumerableSet.Bytes32Set private unfulfilledRequestIds;

    /// @dev Set for storing unique fulfilled transfer request Ids
    EnumerableSet.Bytes32Set private fulfilledRequestIds;

    ISignatureScheme public blsValidator;
    ISettlement public settlement;

    /// @notice Emitted when a message is emitted for cross-chain bridging.
    event MessageEmitted(
        address indexed token,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        uint256 srcChainId,
        uint256 dstChainId,
        uint256 nonce,
        bytes message
    );

    /// @notice Emitted when a cross-chain message is executed.
    event MessageExecuted(address indexed to, address token, uint256 amount, bytes message);

    /// @notice Emitted when ERC20 tokens are rescued.
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);

    constructor(address _owner, address _settlement, address _blsValidator) Ownable(_owner) {
        settlement = ISettlement(_settlement);
        blsValidator = ISignatureScheme(_blsValidator);
        thisChainId = getChainID();
    }

    // INTERNAL

    function transferParamsToBytes(TransferParams memory params)
        public
        view
        returns (bytes memory message, bytes memory messageAsG1Bytes, BLS.PointG1 memory messageAsG1Point)
    {
        message = abi.encode(
            params.sender,
            params.recipient,
            params.token,
            params.amount,
            params.srcChainId,
            params.dstChainId,
            params.nonce
        );
        (uint256 x, uint256 y) = blsValidator.hashToPoint(message);
        messageAsG1Point = BLS.PointG1({x: x, y: y});
        messageAsG1Bytes = blsValidator.hashToBytes(message);
    }

    function storeTransferRequest(bytes32 requestId, TransferParams memory params) internal {
        require(transferStatus[requestId] == TransferStatus.None, "Duplicate");
        transferParameters[requestId] = params;
        unfulfilledRequestIds.add(requestId);
        transferStatus[requestId] = TransferStatus.Requested;
    }

    // SETTERS

    /// @notice Initiates a cross-chain asset transfer.
    function bridge(address token, uint256 amount, uint256 dstChainId, address recipient, uint256 nonce) external {
        //     function bridge(address token, uint256 amount) external {
        //     IERC20(token).approve(omnibridge, amount);
        //     IOmnibridge(omnibridge).relayTokens(token, user, amount);
        // }

        // todo internal function to calculate fee based on transfer amount and dst chain id??
        // or external fee calculation

        require(amount > 0, "Zero amount");

        uint256 bridgeFeeAmount = getBridgeFeeAmountInUnderlying(amount);
        uint256 solverFee = (bridgeFeeAmount * solverFeeBps) / BPS_DIVISOR;
        uint256 remainingFee = bridgeFeeAmount - solverFee;
        uint256 amountAfterFee = amount - bridgeFeeAmount;

        // todo validate supported token and dst chain id

        // Update accounting
        solverFeesCollected[token] += solverFee;
        bridgeFeesCollected[token] += remainingFee;
        totalAmountBridged[token] += amountAfterFee;

        TransferParams memory params = buildTransferParams(token, amountAfterFee, dstChainId, recipient, nonce);
        (bytes memory message,,) = transferParamsToBytes(params);
        // todo map transfer id to bytes message and bool executed meaning its been paid out to solver
        // based on proof from dst chain where funds were paid out
        /// @notice Store transfer request in source chain router
        storeTransferRequest(getRequestId(params), params);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit MessageEmitted(token, msg.sender, recipient, amountAfterFee, thisChainId, dstChainId, nonce, message);
    }

    function buildTransferParams(
        address token,
        uint256 amountAfterFee,
        uint256 dstChainId,
        address recipient,
        uint256 nonce
    ) public view returns (TransferParams memory params) {
        params = TransferParams({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            amount: amountAfterFee,
            srcChainId: thisChainId,
            dstChainId: dstChainId,
            nonce: nonce
        });
    }

    function updateWithdrawableSolverFees(address token, bytes32 requestId) external onlyOwner {
        // todo mapping of solver fee balance
        // solver gets amount from request id and solver fee portion of the request
        // use BLS signature
        /**
         * TransferParams memory params = abi.decode(message, (TransferParams));
         *
         *     require(params.dstChainId == thisChainId, "Invalid dstChainId");
         *     require(allowedSrcChainIds[params.srcChainId], "srcChainId not allowed");
         *     require(!executedMessages[message], "Message already executed");
         *
         *     (, bytes memory messageAsG1Bytes,) = transferParamsToBytes(params);
         *
         *     require(
         *         blsValidator.verifySignature(messageAsG1Bytes, signature, blsValidator.getPublicKeyBytes()),
         *         "Invalid BLS signature"
         *     );
         *
         *     address pool = poolProvider.getPool(params.token, thisChainId);
         *     require(pool != address(0), "No destination pool");
         *
         *     uint256 poolBalance = ILiquidityPool(pool).poolBalance();
         *     require(poolBalance >= params.amount, "Pool insufficient balance");
         *
         *     executedMessages[message] = true;
         *
         *     // --- Release tokens to user ---
         *     ILiquidityPool(pool).releaseTo(params.recipient, params.amount);
         *
         *     bytes32 requestId = getRequestId(params);
         *     fulfilledRequestIds.add(requestId);
         *     require(transferStatus[requestId] == TransferStatus.None, "Already executed");
         *     transferStatus[requestId] = TransferStatus.Executed;
         *
         *     emit MessageExecuted(params.recipient, params.token, params.amount, message);
         */
    }

    function withdrawSolverFees(address token, address to) external {
        // todo update / deduct mapping of solver fee balance
        // msg.sender should be solver
        // reset to zero
    }

    /// @notice Withdraws accumulated bridge fees to owner.
    function withdrawBridgeFees(address token, address to) external onlyOwner {
        // todo
        // validate token, update router balance for token, etc.
        uint256 amount = 0;
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Sets solver fee in basis points.
    function setSolverFeeBps(uint256 _solverFeeBps) external onlyOwner {
        require(_solverFeeBps <= MAX_FEE_BPS, "Too high");
        solverFeeBps = _solverFeeBps;
    }

    /// @notice Sets bridge fee in basis points.
    function setBridgeFeeBps(uint256 _bridgeFeeBps) external onlyOwner {
        require(_bridgeFeeBps <= MAX_FEE_BPS, "Too high");
        bridgeFeeBps = _bridgeFeeBps;
    }

    /// @notice Sets the BLS signature validator contract.
    function setBlsValidator(address _blsValidator) external onlyOwner {
        blsValidator = ISignatureScheme(_blsValidator);
    }

    /// @notice Allows or disallows a destination chain ID for incoming messages on the src chain id.
    function allowDstChainId(uint256 chainId, bool allowed) external onlyOwner {
        allowedDstChainIds[chainId] = allowed;
    }

    /// @notice Sets token mapping between chain pairs.
    function setTokenMapping(uint256 dstChainId, address dstToken, address srcToken) external onlyOwner {
        require(allowedDstChainIds[chainId], "Destination chain id not supported");
        tokenMappings[srcToken][dstChainId] = dstToken;
    }

    // GETTERS

    /// @notice Returns the current chain ID.
    function getChainID() public view returns (uint256) {
        return block.chainid;
    }

    /// @notice Returns a list of all fulfilled requests ids on the dst chain.
    /// Request id is a hash of the bridge request message.
    function getAllFulfilledRequestIds() external view returns (bytes32[] memory) {
        return fulfilledRequestIds.values();
    }

    /// @notice Returns a list of all unfulfilled requests ids on the src chain.
    /// Request id is a hash of the bridge request message.
    function getAllUnfulfilledRequestIds() external view returns (bytes32[] memory) {
        return unfulfilledRequestIds.values();
    }

    /// @notice Returns the amount that will be charged for the cross-chain transfer by the router contract.
    /// @param amount The amount to transfer cross-chain.
    function getBridgeFeeAmountInUnderlying(uint256 amount) public view returns (uint256) {
        return (amount * bridgeFeeBps) / BPS_DIVISOR;
    }

    function getRequestId(TransferParams memory p) public pure returns (bytes32) {
        return keccak256(abi.encode(p.sender, p.recipient, p.token, p.amount, thisChainId(), p.dstChainId, p.nonce));
    }

    /// @notice Rescue ERC20 tokens not tracked in internal mappings.
    /// @dev Only use this for tokens that are NOT actively used by the Router or Pools.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(0), "Invalid token");
        require(to != address(0), "Invalid recipient");

        // Check that this token is not one that we are currently tracking with fees/bridges
        // Check that `token` is not one of:
        // - any srcToken in tokenMappings
        // - any dstToken in tokenMappings
        // - a pool token managed by the PoolAddressProvider

        // Perform transfer
        IERC20(token).safeTransfer(to, amount);
    }
}
