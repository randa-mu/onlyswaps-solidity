import { ethers, formatEther } from "ethers";
import {
    Router__factory,
    ERC20Token__factory,
    BN254SignatureScheme__factory,
} from "../typechain-types";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { AbiCoder, parseEther, Interface, EventFragment, TransactionReceipt, Result } from "ethers";
import { launchAnvilPair } from "./anvil-helper";

/**
Demo script usage:

npx ts-node demo/onlyswaps-e2e-demo.ts

*/

const SRC_CHAIN_ID = 31337;
const DST_CHAIN_ID = 31338;

async function main() {
    const { cleanup } = await launchAnvilPair();
    
    try {
    // Setup providers for two local anvil chains
    const srcProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const dstProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8546");

    // Confirn chain ids for both networks
    console.log("SRC_CHAIN_ID (on-chain):", (await srcProvider.getNetwork()).chainId);
    console.log("DST_CHAIN_ID (on-chain):", (await dstProvider.getNetwork()).chainId);

    const srcSigner = await srcProvider.getSigner(0);
    const dstSigner = await dstProvider.getSigner(0);

    // Deploy ERC20 on both chains
    const ERC20Src = await new ERC20Token__factory(srcSigner).deploy("RUSD", "RUSD", 18);
    const ERC20Dst = await new ERC20Token__factory(dstSigner).deploy("RUSD", "RUSD", 18);

    // Generate BLS keypair
    const privKeyBytes = Uint8Array.from(randomBytes(32));
    const pubKeyBytes = bn254.getPublicKeyForShortSignatures(privKeyBytes);
    const pubKeyPoint = bn254.G2.ProjectivePoint.fromHex(pubKeyBytes).toAffine();

    // Deploy BN254SignatureScheme on both chains (for demonstration)
    const BN254SigSrc = await new BN254SignatureScheme__factory(srcSigner).deploy(
        [pubKeyPoint.x.c0, pubKeyPoint.x.c1],
        [pubKeyPoint.y.c0, pubKeyPoint.y.c1],
    );
    const BN254SigDst = await new BN254SignatureScheme__factory(dstSigner).deploy(
        [pubKeyPoint.x.c0, pubKeyPoint.x.c1],
        [pubKeyPoint.y.c0, pubKeyPoint.y.c1],
    );

    // Deploy Router on both chains
    const RouterSrc = await new Router__factory(srcSigner).deploy(
        await srcSigner.getAddress(),
        await BN254SigSrc.getAddress(),
    );

    const RouterDst = await new Router__factory(dstSigner).deploy(
        await dstSigner.getAddress(),
        await BN254SigDst.getAddress(),
    );

    // Configure router on source chain: allow dest chain id and token mapping
    await RouterSrc.permitDestinationChainId(DST_CHAIN_ID);
    await RouterSrc.setTokenMapping(DST_CHAIN_ID, await ERC20Dst.getAddress(), await ERC20Src.getAddress());

    // Configure router on destination chain: allow dest chain id and token mapping
    await RouterDst.permitDestinationChainId(SRC_CHAIN_ID);
    await RouterDst.setTokenMapping(SRC_CHAIN_ID, await ERC20Src.getAddress(), await ERC20Dst.getAddress());

    // Create cross-chain swap request on source chain (user -> recipient on dest chain)
    const userAddr = await srcSigner.getAddress();
    const recipientAddr = await dstSigner.getAddress();
    const amount = parseEther("10");
    const fee = parseEther("1");
    const totalAmount = amount + fee;

    // Mint tokens to user on source chain
    await ERC20Src.mint(userAddr, totalAmount);

    // Approve Router on source chain
    await ERC20Src.approve(await RouterSrc.getAddress(), totalAmount);

    const tx = await RouterSrc.requestCrossChainSwap(
        await ERC20Src.getAddress(),
        amount,
        fee,
        DST_CHAIN_ID,
        recipientAddr,
    );
    const receipt = await tx.wait();

    if (!receipt) {
      throw new Error("transaction has not been mined");
    }

    // Extract requestId from SwapRequested event
    const iface = RouterSrc.interface;

    const [requestId, ] = extractSingleLog(
        iface,
        receipt,
        await RouterSrc.getAddress(),
        iface.getEvent("SwapRequested"),
    );

    if (!requestId) throw new Error("SwapRequested event not found");

    console.log(`Swap request created with requestId ${requestId}`);

    // Fetch transfer parameters for requestId
    const transferParams = await RouterSrc.getTransferParameters(requestId);

    let transferParamsObject = {
        sender: transferParams.sender,
        recipient: transferParams.recipient,
        token: transferParams.token,
        amount: transferParams.amount,
        srcChainId: transferParams.srcChainId,
        dstChainId: transferParams.dstChainId,
        swapFee: transferParams.swapFee,
        solverFee: transferParams.solverFee,
        nonce: transferParams.nonce,
        executed: transferParams.executed,
    }

    // Convert transferParams message to G1 point as per your contract's scheme
    const [, , messageAsG1Point] = await RouterSrc.transferParamsToBytes(transferParamsObject);
    
    const formattedTransferParams = {
        sender: transferParams.sender,
        recipient: transferParams.recipient,
        token: transferParams.token,
        amount: formatEther(transferParams.amount),
        srcChainId: transferParams.srcChainId,
        dstChainId: transferParams.dstChainId,
        swapFee: formatEther(transferParams.swapFee),
        solverFee: formatEther(transferParams.solverFee),
        nonce: transferParams.nonce,
        executed: transferParams.executed,
    };

    console.log("Swap request parameters:", formattedTransferParams);

    // Simulate relaying tokens on destination chain (recipient gets tokens)
    // Mint tokens on destination chain for recipient to simulate receipt
    await ERC20Dst.mint(await dstSigner.getAddress(), amount);
    await ERC20Dst.approve(await RouterDst.getAddress(), amount);
    
    await RouterDst.relayTokens(await ERC20Dst.getAddress(), recipientAddr, amount, requestId, SRC_CHAIN_ID);
    console.log(`Recipient ${recipientAddr} received ${formatEther(amount)} tokens on destination chain`);

    // Rebalance solver on source chain with BLS signature

    // Create G1 projective point from message
    const M = bn254.G1.ProjectivePoint.fromAffine({
        x: BigInt(messageAsG1Point[0]),
        y: BigInt(messageAsG1Point[1]),
    });

    // Sign message with private key (BLS signature)
    const sigPoint = bn254.signShortSignature(M, privKeyBytes);
    const sigAffine = sigPoint.toAffine();

    // Encode signature as bytes for the contract call
    const abiCoder = new AbiCoder();
    const sigBytes = abiCoder.encode(["uint256", "uint256"], [sigAffine.x, sigAffine.y]);

    // Before rebalancing, print solver balance
    const solverAddr = await srcSigner.getAddress();
    const balanceBefore = await ERC20Src.balanceOf(solverAddr);
    console.log("Solver balance before rebalance:", balanceBefore.toString());

    // Rebalance solver on source chain with signature
    const rebalanceTx = await RouterSrc.rebalanceSolver(solverAddr, requestId, sigBytes);
    await rebalanceTx.wait();

    // After rebalancing, print solver balance
    const balanceAfter = await ERC20Src.balanceOf(solverAddr);
    console.log("Solver balance after rebalance:", balanceAfter.toString());
} catch (err) {
    console.error("Error during demo execution:", err);
  } finally {
    cleanup();
  }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

// Returns the first instance of an event log from a transaction receipt that matches the address provided
function extractSingleLog<T extends Interface, E extends EventFragment>(
    iface: T,
    receipt: TransactionReceipt,
    contractAddress: string,
    event: E,
): Result {
    const events = extractLogs(iface, receipt, contractAddress, event);
    if (events.length === 0) {
        throw Error(`contract at ${contractAddress} didn't emit the ${event.name} event`);
    }
    return events[0];
}

function extractLogs<T extends Interface, E extends EventFragment>(
    iface: T,
    receipt: TransactionReceipt,
    contractAddress: string,
    event: E,
): Array<Result> {
    return receipt.logs
        .filter((log) => log.address.toLowerCase() === contractAddress.toLowerCase())
        .map((log) => iface.decodeEventLog(event, log.data, log.topics));
}
