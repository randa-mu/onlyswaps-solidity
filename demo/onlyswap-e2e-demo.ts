import { ethers, formatEther } from "ethers";
import { launchAnvilPair } from "./utilities/anvil-helper";
import { generateBlsKeys, signMessage, encodeSignature } from "./utilities/signing";
import { deployContracts } from "./utilities/deploy-contracts";
import { executeSwap } from "./utilities/swap";
import { extractSingleLog } from "./utilities/ethers-utils";

// Usage: npx ts-node demo/onlyswap-e2e-demo.ts

const SRC_CHAIN_ID = 31337;
const DST_CHAIN_ID = 31338;

async function main() {
  const { cleanup } = await launchAnvilPair();

  try {
    const srcProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const dstProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8546");

    const srcSigner = await srcProvider.getSigner(0);
    const dstSigner = await dstProvider.getSigner(1);
    const recipientSigner = await dstProvider.getSigner(2);
    const recipientAddr = await recipientSigner.getAddress();
    const solverAddr = await dstSigner.getAddress();
    
    const { privKeyBytes, pubKeyPoint } = generateBlsKeys();

    const { ERC20Src, ERC20Dst, RouterSrc, RouterDst } = await deployContracts(
      srcSigner,
      dstSigner,
      pubKeyPoint
    );

    console.log("Configuring routers...");
    await RouterSrc.permitDestinationChainId(DST_CHAIN_ID);
    await RouterSrc.setTokenMapping(
      DST_CHAIN_ID,
      await ERC20Dst.getAddress(),
      await ERC20Src.getAddress()
    );
    await RouterDst.permitDestinationChainId(SRC_CHAIN_ID);
    await RouterDst.setTokenMapping(
      SRC_CHAIN_ID,
      await ERC20Src.getAddress(),
      await ERC20Dst.getAddress()
    );

    const recipientBalanceBefore = await ERC20Dst.balanceOf(recipientAddr);
    console.log(`Recipient balance before swap request: ${formatEther(recipientBalanceBefore)} RUSD`);

    const { tx, amount } = await executeSwap(
      ERC20Src,
      RouterSrc,
      recipientAddr,
      DST_CHAIN_ID,
      srcSigner
    );

    const receipt = await tx.wait();
    const iface = RouterSrc.interface;
    const [requestId] = extractSingleLog(
      iface,
      receipt!,
      await RouterSrc.getAddress(),
      iface.getEvent("SwapRequested")
    );

    const swapRequestParams = await RouterSrc.getSwapRequestParameters(requestId);

    const formattedSwapRequestParams = {
      sender: swapRequestParams.sender,
      recipient: swapRequestParams.recipient,
      token: swapRequestParams.token,
      amount: formatEther(swapRequestParams.amount),
      srcChainId: swapRequestParams.srcChainId,
      dstChainId: swapRequestParams.dstChainId,
      verificationFee: formatEther(swapRequestParams.verificationFee),
      solverFee: formatEther(swapRequestParams.solverFee),
      nonce: swapRequestParams.nonce,
      executed: swapRequestParams.executed,
    };

    console.log(`Swap request created with requestId ${requestId}`);
    console.log("Swap request parameters:", formattedSwapRequestParams);

    const [, , messageAsG1Point] = await RouterSrc.swapRequestParametersToBytes(
      requestId
    );

    const sigAffine = signMessage(
      { x: BigInt(messageAsG1Point[0]), y: BigInt(messageAsG1Point[1]) },
      privKeyBytes
    );
    const sigBytes = encodeSignature(sigAffine);

    await ERC20Dst.mint(solverAddr, amount);
    await ERC20Dst.approve(await RouterDst.getAddress(), amount);
    await RouterDst.relayTokens(
      await ERC20Dst.getAddress(),
      recipientAddr,
      amount,
      requestId,
      SRC_CHAIN_ID
    );

    const recipientBalanceAfter = await ERC20Dst.balanceOf(recipientAddr);
    console.log(`Recipient balance after relay: ${formatEther(recipientBalanceAfter)} RUSD`);

    const solverBalanceBefore = await ERC20Src.balanceOf(solverAddr);
    console.log(`Solver balance before rebalance: ${formatEther(solverBalanceBefore)} RUSD`);

    const rebalanceTx = await RouterSrc.rebalanceSolver(solverAddr, requestId, sigBytes);
    await rebalanceTx.wait();

    const solverBalanceAfter = await ERC20Src.balanceOf(solverAddr);
    console.log(`Solver balance after rebalance: ${formatEther(solverBalanceAfter)} RUSD`);
  } catch (err) {
    console.error("Error during execution:", err);
  } finally {
    cleanup();
  }
}

main().catch(console.error);
