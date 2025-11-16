import {
  Router,
  Router__factory,
  ERC20Token,
  ERC20Token__factory,
  BLSBN254SignatureScheme,
  BLSBN254SignatureScheme__factory,
  UUPSProxy__factory,
  Permit2Relayer,
  Permit2Relayer__factory,
  Permit2__factory,
} from "../../typechain-types";
import { extractSingleLog, EMPTY_HOOKS } from "./utils/utils";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { AbiCoder, parseEther, keccak256, toUtf8Bytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

const DST_CHAIN_ID = 137;

const VERIFICATION_FEE_BPS = 500;

describe("Message Signing", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let solver: SignerWithAddress;
  let solverRefundWallet: SignerWithAddress;
  let recipient: SignerWithAddress;

  let router: Router;
  let srcToken: ERC20Token;
  let dstToken: ERC20Token;
  let swapBn254SigScheme: BLSBN254SignatureScheme;
  let upgradeBn254SigScheme: BLSBN254SignatureScheme;
  let permit2Relayer: Permit2Relayer;

  let privKeyBytes: Uint8Array;
  let ownerAddr: string, solverAddr: string, solverRefundAddr: string, userAddr: string, recipientAddr: string;

  const swapType = "swap-v1";
  const upgradeType = "upgrade-v1";

  beforeEach(async () => {
    [owner, user, solver, solverRefundWallet, recipient] = await ethers.getSigners();

    ownerAddr = await owner.getAddress();
    userAddr = await user.getAddress();
    recipientAddr = await recipient.getAddress();
    solverAddr = await solver.getAddress();
    solverRefundAddr = await solverRefundWallet.getAddress();

    // Create random private key and public key
    privKeyBytes = Uint8Array.from(randomBytes(32));
    const pk = bn254.getPublicKeyForShortSignatures(privKeyBytes); // G2 public key

    // Deserialize public key from a Uint8Array to G2 point
    const pubKeyPoint = bn254.G2.ProjectivePoint.fromHex(pk).toAffine();
    // Extract x and y (each is an Fp2: { c0, c1 } as BigInt)
    const { x, y } = pubKeyPoint;

    // Deploy contracts
    srcToken = await new ERC20Token__factory(owner).deploy("RUSD", "RUSD", 18);
    dstToken = await new ERC20Token__factory(owner).deploy("RUSD", "RUSD", 18);
    // Deploy BLS signature scheme with the public key G2 point swapped around to be compatible with the BLS solidity library
    swapBn254SigScheme = await new BLSBN254SignatureScheme__factory(owner).deploy([x.c0, x.c1], [y.c0, y.c1], swapType);
    upgradeBn254SigScheme = await new BLSBN254SignatureScheme__factory(owner).deploy(
      [x.c0, x.c1],
      [y.c0, y.c1],
      upgradeType,
    );
    // Deploy Permit2
    const permit2 = await new Permit2__factory(owner).deploy();
    await permit2.waitForDeployment();
    // Deploy Permit2Relayer
    permit2Relayer = await new Permit2Relayer__factory(owner).deploy(await permit2.getAddress());

    const Router = new ethers.ContractFactory(Router__factory.abi, Router__factory.bytecode, owner);

    // Deploy Router implementation
    const routerImplementation: Router = await new Router__factory(owner).deploy();
    await routerImplementation.waitForDeployment();

    // Deploy UUPS proxy for Router using the implementation address and initialize data
    const UUPSProxy = new ethers.ContractFactory(UUPSProxy__factory.abi, UUPSProxy__factory.bytecode, owner);
    const routerProxy = await UUPSProxy.deploy(
      await routerImplementation.getAddress(),
      Router.interface.encodeFunctionData("initialize", [
        ownerAddr,
        await swapBn254SigScheme.getAddress(),
        await upgradeBn254SigScheme.getAddress(),
        VERIFICATION_FEE_BPS,
      ]),
    );
    await routerProxy.waitForDeployment();

    // Attach Router interface to proxy address
    const routerAttached = Router__factory.connect(await routerProxy.getAddress(), owner);
    router = routerAttached;

    // Router contract configuration
    await router.connect(owner).setPermit2Relayer(await permit2Relayer.getAddress());
    await router.connect(owner).permitDestinationChainId(DST_CHAIN_ID);
    await router.connect(owner).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());
  });

  describe("rebalanceSolver", function () {
    it("should rebalance solver and transfer correct amount with correctly generated message to sign off-chain", async () => {
      // Create token swap request on source chain
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      const tx = await router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          amount,
          solverFee,
          DST_CHAIN_ID,
          recipient.address,
        );

      let receipt = await tx.wait();
      if (!receipt) {
        throw new Error("transaction has not been mined");
      }

      const routerInterface = Router__factory.createInterface();
      const [requestId] = extractSingleLog(
        routerInterface,
        receipt,
        await router.getAddress(),
        routerInterface.getEvent("SwapRequested"),
      );

      // Message signing
      const swapRequestParams = await router.getSwapRequestParameters(requestId);
      const hooksType = "tuple(address,bytes,uint256)[]";

      const preHooksEncoded = AbiCoder.defaultAbiCoder().encode(
        [hooksType],
        [swapRequestParams.preHooks.map((h: any) => [h.target, h.callData, h.gasLimit])],
      );
      const preHooksHash = keccak256(preHooksEncoded);

      const postHooksEncoded = AbiCoder.defaultAbiCoder().encode(
        [hooksType],
        [swapRequestParams.postHooks.map((h: any) => [h.target, h.callData, h.gasLimit])],
      );
      const postHooksHash = keccak256(postHooksEncoded);

      const encodedMessageGeneratedOffChain = AbiCoder.defaultAbiCoder().encode(
        [
          "address", // solver
          "address", // params.sender
          "address", // params.recipient
          "address", // params.tokenIn
          "address", // params.tokenOut
          "uint256", // params.amountIn
          "uint256", // params.amountOut
          "uint256", // params.srcChainId
          "uint256", // params.dstChainId
          "uint256", // params.nonce
          "bytes32", // keccak256(abi.encode(params.preHooks))
          "bytes32", // keccak256(abi.encode(params.postHooks))
        ],
        [
          solver.address,
          swapRequestParams.sender,
          swapRequestParams.recipient,
          swapRequestParams.tokenIn,
          swapRequestParams.tokenOut,
          swapRequestParams.amountIn,
          swapRequestParams.amountOut,
          swapRequestParams.srcChainId,
          swapRequestParams.dstChainId,
          swapRequestParams.nonce,
          preHooksHash,
          postHooksHash,
        ],
      );
      const encodedMessageGeneratedOffChainAsG1Bytes = await swapBn254SigScheme.hashToBytes(
        encodedMessageGeneratedOffChain,
      );

      // Ensure that the message generated off-chain matches the on-chain generated message
      const [, messageAsG1BytesOnChain] = await router.swapRequestParametersToBytes(requestId, solver.address);
      expect(encodedMessageGeneratedOffChainAsG1Bytes).to.equal(messageAsG1BytesOnChain);

      // Sign message generated off-chain
      // Remove "0x" prefix if present
      const messageHex = encodedMessageGeneratedOffChainAsG1Bytes.startsWith("0x")
        ? encodedMessageGeneratedOffChainAsG1Bytes.slice(2)
        : encodedMessageGeneratedOffChainAsG1Bytes;
      // Unmarshall messageAsG1Bytes to a G1 point first
      const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
      // Sign message
      const sigPoint = bn254.signShortSignature(M, privKeyBytes);
      // Serialize signature (x, y) for EVM
      const sigPointToAffine = sigPoint.toAffine();
      const sigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [sigPointToAffine.x, sigPointToAffine.y],
      );

      // Alternatively, sign message generated on-chain to demonstrate that both methods yield the same signature

      const [, messageAsG1Bytes] = await router.swapRequestParametersToBytes(requestId, solver.address);
      // Remove "0x" prefix if present
      const messageHexOnChain = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
      // Unmarshall messageAsG1Bytes to a G1 point first
      const M_OnChain = bn254.G1.ProjectivePoint.fromHex(messageHexOnChain);
      // Sign message
      const sigPointOnChain = bn254.signShortSignature(M_OnChain, privKeyBytes);
      // Serialize signature (x, y) for EVM
      const sigPointToAffineOnChain = sigPointOnChain.toAffine();
      const sigBytesOnChain = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [sigPointToAffineOnChain.x, sigPointToAffineOnChain.y],
      );
      // Ensure that both signatures match
      expect(sigBytes).to.equal(sigBytesOnChain);

      // ensure that the router has enough liquidity to pay solver
      expect(await srcToken.balanceOf(await router.getAddress())).to.be.greaterThanOrEqual(
        swapRequestParams.amountOut + swapRequestParams.solverFee,
      );

      const before = await srcToken.balanceOf(solverAddr);

      expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(0);
      expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(1);

      // Rebalance Solver

      // Try with invalid request ID first
      const invalidRequestId = keccak256(toUtf8Bytes("invalid"));
      await expect(
        router.connect(owner).rebalanceSolver(solver.address, invalidRequestId, sigBytes),
      ).to.be.revertedWithCustomError(router, "SourceChainIdMismatch");

      // Rebalance with valid request ID
      await router.connect(owner).rebalanceSolver(solver.address, requestId, sigBytes);

      const after = await srcToken.balanceOf(solverAddr);
      expect(after - before).to.equal(amount + swapRequestParams.solverFee - swapRequestParams.verificationFee);
      expect(await srcToken.balanceOf(await router.getAddress())).to.be.equal(swapRequestParams.verificationFee);

      expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(1);
      expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(0);

      // Try to rebalance again
      await expect(
        router.connect(owner).rebalanceSolver(solver.address, requestId, sigBytes),
      ).to.be.revertedWithCustomError(router, "AlreadyFulfilled()");
    });
  });
});
