import { JsonRpcProvider, Wallet, Contract, TransactionReceipt, Interface, EventFragment, Result, AbiCoder, MaxUint256, getBytes, hexlify, keccak256, parseEther, sha256, toUtf8Bytes } from "ethers";
import { ethers } from "ethers";
import { BlsBn254, kyberG1ToEvm, kyberG2ToEvm, toHex, kyberMarshalG1, kyberMarshalG2 } from "../test/hardhat/crypto";
import dotenv from "dotenv";

import {
  Router__factory,
  Bridge__factory,
  BN254SignatureScheme__factory,
  ERC20Token__factory,
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
  router_contractAddress: string;
  bridge_contractAddress: string;
}

// Load chain configurations from env variables CHAIN_ID_i, RPC_URL_i, CONTRACT_ADDR_i
const supportedChains: ChainConfig[] = [];

for (let i = 1; ; i++) {
  const chainIdStr = process.env[`CHAIN_ID_${i}`];
  const rpcUrl = process.env[`RPC_URL_${i}`];
  const routerContractAddress = process.env[`CONTRACT_ADDR_${i}`];
  const bridgeContractAddress = process.env[`ROUTER_CONTRACT_ADDR_${i}`];
  if (!chainIdStr || !rpcUrl || !routerContractAddress || !bridgeContractAddress) break;

  supportedChains.push({
    chainId: Number(chainIdStr),
    name: `Chain${i}`,
    rpcUrl,
    router_contractAddress: routerContractAddress,
    bridge_contractAddress: bridgeContractAddress
  });
}

if (supportedChains.length === 0) {
  throw new Error("No supported chains loaded from environment variables.");
}

// Load signer private key 
// It should have execution rights on the source and destination contracts
const signerPrivateKey = process.env.PRIVATE_KEY!;
if (!signerPrivateKey) {
  throw new Error("SIGNER_PRIVATE_KEY env var required");
}
const signerWallet = new Wallet(signerPrivateKey);
const signerAddress = signerWallet.address;

// BLS secret key for signing transfer messages
const blsSecretKeyHex = process.env.BLS_PRIVATE_KEY!;
if (!blsSecretKeyHex) {
  throw new Error("BLS_SECRET_KEY env var required");
}

// Helper: get ChainConfig by chainId
function getChainById(chainId: number) {
  return supportedChains.find((c) => c.chainId === chainId);
}

// Function to create ethers Contract for Router connected to signer or provider
function getRouterContract(chain: ChainConfig, withSigner = false) {
  const provider = new JsonRpcProvider(chain.rpcUrl);
  return new Contract(
    chain.router_contractAddress,
    routerAbi,
    withSigner ? signerWallet.connect(provider) : provider
  );
}

// Function to create ethers Contract for Bridge connected to signer or provider
function getBridgeContract(chain: ChainConfig, withSigner = false) {
  const provider = new JsonRpcProvider(chain.rpcUrl);
  return new Contract(
    chain.bridge_contractAddress,
    bridgeAbi,
    withSigner ? signerWallet.connect(provider) : provider
  );
}

// Function to create ethers Contract for ERC-20 Token connected to signer or provider
function getTokenContract(tokenAddress, chain: ChainConfig, withSigner = false) {
  const provider = new JsonRpcProvider(chain.rpcUrl);
  const erc20Abi = ERC20Token__factory.abi;
  return new Contract(
    tokenAddress,
    erc20Abi,
    withSigner ? signerWallet.connect(provider) : provider
  );
}

// Poll interval in ms
const POLL_INTERVAL = 10_000;

async function pollAndExecute() {
  console.log(`Starting poll cycle at ${new Date().toISOString()}`);

  for (const srcChain of supportedChains) {
    const srcContract = getRouterContract(srcChain, false);

    try {
      const unfulfilledRequestIds: string[] = await srcContract.getAllUnfulfilledRequestIds();

      if (unfulfilledRequestIds.length === 0) {
        console.log(`[${srcChain.name}] No unfulfilled requests`);
        continue;
      }

      console.log(`[${srcChain.name}] Found ${unfulfilledRequestIds.length} unfulfilled requests`);

      for (const requestId of unfulfilledRequestIds) {
        // Fetch transfer params from source contract storage
        const params = await srcContract.getTransferParameters(requestId);
        // params shape matches TransferParams struct:
        /* struct TransferParams {
          address sender;
          address recipient;
          address token;
          uint256 amount; // user receives amount minus bridgeFee
          uint256 srcChainId;
          uint256 dstChainId;
          uint256 bridgeFee; // deducted from amount
          uint256 solverFee; // deducted from bridge fee
          uint256 nonce;
          bool executed;
        } */

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
        const dstContract = getBridgeContract(dstChain, true);

        // Check if requestId is fulfilled on destination chain (Bridge contract)
        const fulfilled = await dstContract.isFulfilled(requestId);

        if (fulfilled) {
          console.log(`[${dstChain.name}] Request ${requestId} already fulfilled`);
          continue;
        } 

        // Fulfill request on destination chain as it's not already fulfilled
        try {
          const amountOut = params.amount - params.bridgeFee;
          const tokenAddress = await srcContract.getTokenMapping(params.token, params.dstChainId);

          const tokenContract = getTokenContract(tokenAddress, dstChain, true);
          
          // Approve tokens for bridge contract first
          await tokenContract.approve(await dstContract.getAddress(), amountOut);

          const tx = await dstContract.relayTokens(
            tokenAddress,
            params.recipient,
            amountOut,
            requestId, 
            params.srcChainId
          );
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

        // Confirm it's fulfilled on-chain and log the receipt from the destination chain Bridge contract


        // Reinburse solver via the source chain Router contract
        const transferParams = {
          sender: params.sender,
          recipient: params.recipient,
          token: params.token,
          amount: params.amount, // user receives amount minus bridgeFee
          srcChainId: params.srcChainId,
          dstChainId: params.dstChainId,
          bridgeFee: params.bridgeFee, // deducted from amount
          solverFee: params.solverFee, // deducted from bridge fee
          nonce: params.nonce,
          executed: params.executed
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

        // Execute message on source router contract to refund solver
        try {
          const solverAddress = signerAddress;
          const tx = await srcContract.rebalanceSolver(
            solverAddress, 
            requestId, 
            message, 
            sigBytes
          );
          console.log(`[${srcChain.name}] Rebalancing solver for request ${requestId}, tx hash: ${tx.hash}`);

          // Wait for tx mined
          const receipt = await tx.wait();
          if (receipt.status === 1) {
            console.log(`[${srcChain.name}] Request ${requestId} executed successfully`);
          } else {
            console.warn(`[${srcChain.name}] Request ${requestId} execution failed`);
          }
        } catch (execError) {
          console.error(`[${srcChain.name}] Failed to rebalance solver for request ${requestId}`, execError);
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