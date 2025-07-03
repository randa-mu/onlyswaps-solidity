import { JsonRpcProvider, Wallet, Contract, TransactionReceipt, Interface, EventFragment, Result, AbiCoder, MaxUint256, getBytes, hexlify, keccak256, parseEther, sha256, toUtf8Bytes } from "ethers";
import { ethers } from "ethers";
import { BlsBn254, kyberG1ToEvm, kyberG2ToEvm, toHex, kyberMarshalG1, kyberMarshalG2 } from "../test/hardhat/crypto";
import dotenv from "dotenv";

import {
  Router__factory,
  Bridge__factory,
  BN254SignatureScheme__factory,
} from "../typechain-types";

import { config } from "dotenv";

// Load environment variables from .env
config();

const routerAbi = Router__factory.abi;
const bridgeAbi = Bridge__factory.abi;
const blsValidatorAbi = BN254SignatureScheme__factory.abi;


interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  contractAddress: string;
}

// Load chain configs from env variables CHAIN_ID_i, RPC_URL_i, CONTRACT_ADDR_i
const supportedChains: ChainConfig[] = [];

for (let i = 1; ; i++) {
  const chainIdStr = process.env[`CHAIN_ID_${i}`];
  const rpcUrl = process.env[`RPC_URL_${i}`];
  const contractAddress = process.env[`CONTRACT_ADDR_${i}`];
  if (!chainIdStr || !rpcUrl || !contractAddress) break;

  supportedChains.push({
    chainId: Number(chainIdStr),
    name: `Chain${i}`,
    rpcUrl,
    contractAddress,
  });
}

if (supportedChains.length === 0) {
  throw new Error("No supported chains loaded from environment variables.");
}

// Your signer private key (should have execution rights on destination contracts)
const signerPrivateKey = process.env.PRIVATE_KEY!;
if (!signerPrivateKey) {
  throw new Error("SIGNER_PRIVATE_KEY env var required");
}
const signerWallet = new Wallet(signerPrivateKey);

// BLS secret key for signing transfer messages
const blsSecretKeyHex = process.env.BLS_PRIVATE_KEY!;
if (!blsSecretKeyHex) {
  throw new Error("BLS_SECRET_KEY env var required");
}

// Helper: get ChainConfig by chainId
function getChainById(chainId: number) {
  return supportedChains.find((c) => c.chainId === chainId);
}

// Function to create ethers Contract connected to signer or provider
function getContract(chain: ChainConfig, withSigner = false) {
  const provider = new JsonRpcProvider(chain.rpcUrl);
  return new Contract(
    chain.contractAddress,
    routerAbi,
    withSigner ? signerWallet.connect(provider) : provider
  );
}

// Poll interval in ms
const POLL_INTERVAL = 10_000;

async function pollAndExecute() {
  console.log(`Starting poll cycle at ${new Date().toISOString()}`);

  for (const srcChain of supportedChains) {
    const srcContract = getContract(srcChain, false);

    try {
      const unfulfilledRequestIds: string[] = await srcContract.getAllUnfulfilledRequestIds();

      if (unfulfilledRequestIds.length === 0) {
        console.log(`[${srcChain.name}] No unfulfilled requests`);
        continue;
      }

      console.log(`[${srcChain.name}] Found ${unfulfilledRequestIds.length} unfulfilled requests`);

      for (const requestId of unfulfilledRequestIds) {
        // Fetch transfer params from source contract storage
        const params = await srcContract.transferParameters(requestId);
        // params shape matches TransferParams struct: {sender, recipient, token, amount, srcChainId, dstChainId, nonce}

        // Validate params object keys exist
        if (!params || !params.dstChainId) {
          console.warn(`[${srcChain.name}] Invalid params for requestId ${requestId}`);
          continue;
        }

        // Get destination chain config
        const dstChain = getChainById(Number(params.dstChainId));
        if (!dstChain) {
          console.warn(`[${srcChain.name}] Destination chainId ${params.dstChainId} not supported`);
          continue;
        }

        // Destination contract instance
        const dstContract = getContract(dstChain, true);

        // Check if requestId is fulfilled on destination chain
        const fulfilled = await dstContract.transferStatus(requestId);
        // transferStatus enum: 0 = None, 1 = Requested, 2 = Executed
        if (Number(fulfilled) === 2) {
          console.log(`[${dstChain.name}] Request ${requestId} already fulfilled`);
          // Optionally: remove from unfulfilled set on source chain if desired
          continue;
        }

        const transferParams = {
          sender: params.sender,
          recipient: params.recipient,
          token: params.token,
          amount: params.amount,
          srcChainId: params.srcChainId,
          dstChainId: params.dstChainId,
          nonce: params.nonce,
        };
        
        // Generate BLS signature over message
        let mcl: BlsBn254;
        mcl = await BlsBn254.create();

        const [message, messageAsG1Bytes, messageAsG1Point] = await dstContract.transferParamsToBytes.staticCall(transferParams);
        const M = mcl.g1FromEvm(messageAsG1Point.x, messageAsG1Point.y);
        const { secretKey, pubKey } = mcl.createKeyPair(blsSecretKeyHex as `0x${string}`);
        const { signature } = mcl.sign(M, secretKey);

        console.log("Transfer parameters", transferParams)
        console.log("Transfer parameters encoded", message)
        console.log("Transfer parameters encoded as BLS G1 point in bytes", messageAsG1Bytes)
        console.log("Transfer parameters encoded as BLS G1 point x, y", messageAsG1Point)

        const sig = mcl.serialiseG1Point(signature);
        const sigBytes = AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [sig[0], sig[1]]);

        // Execute message on destination contract
        try {
          const tx = await dstContract.executeMessage(message, sigBytes);
          console.log(`[${dstChain.name}] Executing request ${requestId}, tx hash: ${tx.hash}`);

          // Wait for tx mined
          const receipt = await tx.wait();
          if (receipt.status === 1) {
            console.log(`[${dstChain.name}] Request ${requestId} executed successfully`);
          } else {
            console.warn(`[${dstChain.name}] Request ${requestId} execution failed`);
          }
        } catch (execError) {
          console.error(`[${dstChain.name}] Failed to execute request ${requestId}`, execError);
        }
      }
    } catch (err) {
      console.error(`[${srcChain.name}] Error fetching unfulfilled requests or params`, err);
    }
  }
}

// Start polling loop
setInterval(pollAndExecute, POLL_INTERVAL);

// Initial start
pollAndExecute();


// usage: npx ts-node agent/agent.ts