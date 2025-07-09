import {
  JsonRpcProvider,
  Wallet,
  Contract,
  AbiCoder,
} from "ethers";
import path from "path";
import fs from "fs/promises";
import {
  Router__factory,
  ERC20Token__factory,
} from "../typechain-types";
import { config } from "dotenv";
import { BlsBn254 } from "../test/hardhat/crypto";

config(); // Load env variables

// Types
interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  router_contractAddress: string;
}

// Globals
const routerAbi = Router__factory.abi;
const supportedChains: ChainConfig[] = [];
const POLL_INTERVAL = 20_000; // ms
const abiCoder = AbiCoder.defaultAbiCoder();

const signerPrivateKey = process.env.PRIVATE_KEY;
if (!signerPrivateKey) throw new Error("PRIVATE_KEY env var required");
const signerWallet = new Wallet(signerPrivateKey);
const signerAddress = signerWallet.address;

const blsSecretKeyHex = process.env.BLS_PRIVATE_KEY;
if (!blsSecretKeyHex) throw new Error("BLS_PRIVATE_KEY env var required");

// In-memory sets to track requests already processed (persist across poll cycles)
const relaySentRequests = new Set<string>();
const rebalanceSentRequests = new Set<string>();

// Load supported chains from env
async function loadSupportedChains(): Promise<void> {
  let i = 1;
  while (true) {
    const chainIdStr = process.env[`CHAIN_ID_${i}`];
    const rpcUrl = process.env[`RPC_URL_${i}`];
    const routerAddr = process.env[`ROUTER_CONTRACT_ADDR_${i}`];
    if (!chainIdStr || !rpcUrl || !routerAddr) break;

    const chainId = Number(chainIdStr);
    const name = await getNetworkNameFromChainId(chainId);

    supportedChains.push({
      chainId,
      name,
      rpcUrl,
      router_contractAddress: routerAddr,
    });

    i++;
  }

  if (supportedChains.length === 0) {
    throw new Error("No supported chains loaded from environment variables.");
  }
}

function getChainById(chainId: number): ChainConfig | undefined {
  return supportedChains.find((c) => c.chainId === chainId);
}

function getProvider(chain: ChainConfig) {
  return new JsonRpcProvider(chain.rpcUrl);
}

function getContract(
  abi: any,
  address: string,
  chain: ChainConfig,
  withSigner = false
): Contract {
  const provider = getProvider(chain);
  return new Contract(
    address,
    abi,
    withSigner ? signerWallet.connect(provider) : provider
  );
}

function getRouterContract(chain: ChainConfig, withSigner = false) {
  return getContract(routerAbi, chain.router_contractAddress, chain, withSigner);
}

function getTokenContract(tokenAddress: string, chain: ChainConfig, withSigner = false) {
  const erc20Abi = ERC20Token__factory.abi;
  return getContract(erc20Abi, tokenAddress, chain, withSigner);
}

// Main polling logic
async function pollAndExecute() {
  console.log(`Polling cycle started at ${new Date().toISOString()}`);

  for (const srcChain of supportedChains) {
    const srcContract = getRouterContract(srcChain, true);

    try {
      const unfulfilledRequestIds: string[] = await srcContract.getAllUnfulfilledRequestIds();

      if (unfulfilledRequestIds.length === 0) {
        console.log(`[${srcChain.name}] No unfulfilled requests`);
        continue;
      }
      console.log(`[${srcChain.name}] Found ${unfulfilledRequestIds.length} unfulfilled requests`);

      for (const requestId of unfulfilledRequestIds) {
        const params = await srcContract.getTransferParameters(requestId);
        if (!params || !params.dstChainId) {
          console.warn(`[${srcChain.name}] Invalid params for request ${requestId}`);
          continue;
        }

        const dstChain = getChainById(Number(params.dstChainId));
        if (!dstChain) {
          console.warn(`[${srcChain.name}] Unsupported destination chainId ${params.dstChainId}`);
          continue;
        }

        const dstContract = getRouterContract(dstChain, true);
        const fulfilled = await dstContract.isFulfilled(requestId);
        if (fulfilled) {
          console.log(`[${dstChain.name}] Request ${requestId} already fulfilled`);
        } else {
          if (relaySentRequests.has(requestId)) {
            console.log(`[${dstChain.name}] Relay tx for request ${requestId} already sent, skipping`);
          } else {
            try {
              const amountOut = params.amount;
              const tokenAddress = await srcContract.getTokenMapping(params.token, params.dstChainId);
              const tokenContract = getTokenContract(tokenAddress, dstChain, true);

              // Mint tokens if needed
              const solverBalance = await tokenContract.balanceOf(signerAddress);
              if (solverBalance < amountOut) {
                const mintTx = await tokenContract.mint(signerAddress, amountOut);
                await mintTx.wait();
                console.log(`[${dstChain.name}] Minted tokens for solver, tx: ${mintTx.hash}`);
              }

              // Approve tokens if needed
              const bridgeAddress = await dstContract.getAddress();
              const allowance = await tokenContract.allowance(signerAddress, bridgeAddress);
              if (allowance < amountOut) {
                const approveTx = await tokenContract.approve(bridgeAddress, amountOut);
                await approveTx.wait();
                console.log(`[${dstChain.name}] Approved tokens for Bridge, tx: ${approveTx.hash}`);
              }

              // Relay tokens on destination chain
              const tx = await dstContract.relayTokens(
                tokenAddress,
                params.recipient,
                amountOut,
                requestId,
                params.srcChainId
              );
              relaySentRequests.add(requestId);
              console.log(`[${dstChain.name}] Sending tokens to recipient for request ${requestId}, tx: ${tx.hash}`);

              const receipt = await tx.wait();
              if (receipt.status === 1) {
                console.log(`[${dstChain.name}] Token transfer for ${requestId} executed successfully`);
              } else {
                console.warn(`[${dstChain.name}] Token transfer for ${requestId} failed`);
              }
            } catch (execError) {
              console.error(`[${dstChain.name}] Failed to execute request ${requestId}`, execError);
            }
          }
        }

        try {
          if (params.executed) {
            console.log(`[${srcChain.name}] Solver already rebalanced for request ${requestId}`);
            continue;
          }
          if (rebalanceSentRequests.has(requestId)) {
            console.log(`[${srcChain.name}] Rebalance tx for request ${requestId} already sent, skipping`);
            continue;
          }

          // Prepare transfer params for rebalance signature
          const transferParams = {
            sender: params.sender,
            recipient: params.recipient,
            token: params.token,
            amount: params.amount,
            srcChainId: params.srcChainId,
            dstChainId: params.dstChainId,
            swapFee: params.swapFee,
            solverFee: params.solverFee,
            nonce: params.nonce,
            executed: params.executed,
          };

          // Create BLS signature over transfer params
          const mcl = await BlsBn254.create();

          // Static call to encode transfer params to bytes & G1 point (assumes method returns these)
          const [message, messageAsG1Bytes, messageAsG1Point] = await srcContract.transferParamsToBytes.staticCall(transferParams);
          const M = mcl.g1FromEvm(messageAsG1Point.x, messageAsG1Point.y);
          const { secretKey } = mcl.createKeyPair(blsSecretKeyHex as `0x${string}`);
          const { signature } = mcl.sign(M, secretKey);

          const sig = mcl.serialiseG1Point(signature);
          const sigBytes = abiCoder.encode(["uint256", "uint256"], [sig[0], sig[1]]);

          const tx = await srcContract.rebalanceSolver(
            signerAddress,
            requestId,
            message,
            sigBytes
          );
          rebalanceSentRequests.add(requestId);
          console.log(`[${srcChain.name}] Rebalancing solver for request ${requestId}, tx: ${tx.hash}`);

          const receipt = await tx.wait();
          if (receipt.status === 1) {
            console.log(`[${srcChain.name}] Request ${requestId} rebalanced successfully`);
          } else {
            console.warn(`[${srcChain.name}] Request ${requestId} rebalance failed`);
          }
        } catch (execError) {
          console.error(`[${srcChain.name}] Failed to rebalance solver for request ${requestId}`, execError);
        }
      }
    } catch (err) {
      console.error(`[${srcChain.name}] Error processing requests`, err);
    }
  }
}

async function getNetworkNameFromChainId(chainId: number): Promise<string> {
  const chainsPath = path.join(__dirname, "chains.json");
  try {
    const data = await fs.readFile(chainsPath, "utf8");
    const chains: { chainId: number; name: string }[] = JSON.parse(data);
    const match = chains.find((c) => c.chainId === chainId);
    return match?.name ?? `Unknown (Chain ID: ${chainId})`;
  } catch (err) {
    throw new Error(`Failed to load chains.json at ${chainsPath}: ${(err as Error).message}`);
  }
}

async function main() {
  await loadSupportedChains();
  await pollAndExecute();
  setInterval(pollAndExecute, POLL_INTERVAL);
}

main().catch((err) => {
  console.error("Fatal error in main:", err);
  process.exit(1);
});



// Usage: npx ts-node demo/demo.ts