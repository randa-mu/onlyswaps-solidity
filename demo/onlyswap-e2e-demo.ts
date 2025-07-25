import { ethers, formatEther } from "ethers";
import { launchAnvilPair } from "./utilities/anvil-helper";
import { generateBlsKeys, signMessage } from "./utilities/signing";
import { deployContracts } from "./utilities/deploy-contracts";
import { executeSwap, encodeSignature } from "./utilities/swap";
import { extractSingleLog } from "./utilities/ethers-utils";

const SRC_CHAIN_ID = 31337;
const DST_CHAIN_ID = 31338;

async function main() {
  const { cleanup } = await launchAnvilPair();

  try {
    const srcProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const dstProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8546");

    const srcSigner = await srcProvider.getSigner(0);
    const dstSigner = await dstProvider.getSigner(1);

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

    const recipientAddr = await dstSigner.getAddress();
    const solverAddr = await srcSigner.getAddress();

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

    const transferParams = await RouterSrc.getTransferParameters(requestId);
    const transferParamsObject = {
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
    };

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

    console.log(`Swap request created with requestId ${requestId}`);
    console.log("Swap request parameters:", formattedTransferParams);

    const [, , messageAsG1Point] = await RouterSrc.transferParamsToBytes(
      transferParamsObject
    );

    const sigAffine = signMessage(
      { x: BigInt(messageAsG1Point[0]), y: BigInt(messageAsG1Point[1]) },
      privKeyBytes
    );
    const sigBytes = encodeSignature(sigAffine);

    await ERC20Dst.mint(recipientAddr, amount);
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
