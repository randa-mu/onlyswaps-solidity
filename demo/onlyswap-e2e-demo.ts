import { ethers, formatEther } from "ethers";
import { launchAnvilPair } from "./anvil-helper";
import { generateBlsKeys, signMessage } from "./signing";
import { deployContracts } from "./deploy-contracts";
import { executeSwap, encodeSignature } from "./swap";
import { extractSingleLog } from "./utils";

async function main() {
  const { cleanup } = await launchAnvilPair();

  try {
    const srcProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const dstProvider = new ethers.JsonRpcProvider("http://127.0.0.1:8546");

    const srcSigner = await srcProvider.getSigner(0);
    const dstSigner = await dstProvider.getSigner(0);

    const { privKeyBytes, pubKeyPoint } = generateBlsKeys();
    const { ERC20Src, ERC20Dst, RouterSrc, RouterDst } = await deployContracts(srcSigner, dstSigner, pubKeyPoint);

    await RouterSrc.permitDestinationChainId(31338);
    await RouterSrc.setTokenMapping(31338, await ERC20Dst.getAddress(), await ERC20Src.getAddress());
    await RouterDst.permitDestinationChainId(31337);
    await RouterDst.setTokenMapping(31337, await ERC20Src.getAddress(), await ERC20Dst.getAddress());

    const { tx, amount } = await executeSwap(ERC20Src, RouterSrc, await dstSigner.getAddress(), 31338, srcSigner);
    const receipt = await tx.wait();
    const iface = RouterSrc.interface;
    const [requestId] = extractSingleLog(iface, receipt!, await RouterSrc.getAddress(), iface.getEvent("SwapRequested"));

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

    const [, , messageAsG1Point] = await RouterSrc.transferParamsToBytes(transferParamsObject);

    const sigAffine = signMessage({ x: BigInt(messageAsG1Point[0]), y: BigInt(messageAsG1Point[1]) }, privKeyBytes);
    const sigBytes = encodeSignature(sigAffine);

    await ERC20Dst.mint(await dstSigner.getAddress(), amount);
    await ERC20Dst.approve(await RouterDst.getAddress(), amount);
    await RouterDst.relayTokens(await ERC20Dst.getAddress(), await dstSigner.getAddress(), amount, requestId, 31337);

    await RouterSrc.rebalanceSolver(await srcSigner.getAddress(), requestId, sigBytes);
  } finally {
    cleanup();
  }
}

main().catch(console.error);
