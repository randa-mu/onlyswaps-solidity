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
  Permit2,
  Permit2__factory,
} from "../../typechain-types";
import { extractSingleLog, EMPTY_HOOKS } from "./utils/utils";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { AbiCoder, parseEther, ZeroAddress, MaxUint256, TypedDataEncoder, keccak256 } from "ethers";
import { ethers } from "hardhat";

const DST_CHAIN_ID = 137;

const VERIFICATION_FEE_BPS = 500;

describe("Router", function () {
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
  let permit2: Permit2;

  let privKeyBytes: Uint8Array;
  let ownerAddr: string, solverAddr: string, solverRefundAddr: string, userAddr: string, recipientAddr: string;

  const swapType = "swap-v1";
  const upgradeType = "upgrade-v1";

  async function generateSignatureForBlsValidatorUpdate(
    router: Router,
    action: string,
    validatorAddress: string,
    currentNonce: number,
  ): Promise<string> {
    const [, messageAsG1Bytes] = await router.blsValidatorUpdateParamsToBytes(action, validatorAddress, currentNonce);
    // Remove "0x" prefix if present
    const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
    // Unmarshall messageAsG1Bytes to a G1 point first
    const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
    // Sign message
    const sigPoint = bn254.signShortSignature(M, privKeyBytes);
    // Serialize signature (x, y) for EVM
    const sigPointToAffine = sigPoint.toAffine();
    return AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [sigPointToAffine.x, sigPointToAffine.y]);
  }

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
    permit2 = await new Permit2__factory(owner).deploy();
    await permit2.waitForDeployment();
    // Deploy Permit2Relayer
    permit2Relayer = await new Permit2Relayer__factory(owner).deploy(await permit2.getAddress());
    await permit2Relayer.waitForDeployment();

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

  describe("setPermit2Relayer", function () {
    it("should set the Permit2 relayer address", async () => {
      const newPermit2Relayer = await new Permit2Relayer__factory(owner).deploy(await permit2.getAddress());
      await router.connect(owner).setPermit2Relayer(await newPermit2Relayer.getAddress());
      expect(await router.permit2Relayer()).to.equal(await newPermit2Relayer.getAddress());
    });

    it("should fail to set the Permit2 relayer address when called by non-admin", async () => {
      const newPermit2Relayer = await new Permit2Relayer__factory(owner).deploy(await permit2.getAddress());
      await expect(
        router.connect(user).setPermit2Relayer(await newPermit2Relayer.getAddress()),
      ).to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    });

    it("should fail to set the Permit2 relayer address to zero address", async () => {
      await expect(router.connect(owner).setPermit2Relayer(ZeroAddress)).to.be.revertedWithCustomError(
        router,
        "ZeroAddress",
      );
    });
  });

  describe("requestCrossChainSwapPermit2", function () {
    it("should make a swap request with a valid Permit2 signature and emit swap requested event", async () => {
      const amountIn = parseEther("10");
      const amountOut = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amountIn + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      // Generate Permit2 signature with witness data
      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOut", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
          solverFee: solverFee.toString(),
          dstChainId: DST_CHAIN_ID,
          recipient: recipientAddr,
          additionalData: "0x",
        },
      };

      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      // local verification
      const recovered = ethers.verifyTypedData(permit2Domain, permit2Types, permit2Message, signature);
      const digest = TypedDataEncoder.hash(permit2Domain, permit2Types, permit2Message);
      const recovered2 = ethers.recoverAddress(digest, signature);

      expect(
        recovered &&
          recovered.toLowerCase() === userAddr.toLowerCase() &&
          recovered2.toLowerCase() === userAddr.toLowerCase(),
      ).to.be.true;

      // on-chain verification and swap request
      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        solverFee: solverFee.toString(),
        dstChainId: DST_CHAIN_ID,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,

      };

      await expect(router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params)).to.emit(
        router,
        "SwapRequested",
      );
    });

    it("should make a swap request with a valid Permit2 signature and emit swap requested event with the correct request id", async () => {
      const amountIn = parseEther("10");
      const amountOut = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amountIn + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      // Generate Permit2 signature with witness data
      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOut", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
          solverFee: solverFee.toString(),
          dstChainId: DST_CHAIN_ID,
          recipient: recipientAddr,
          additionalData: "0x",
        },
      };

      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        solverFee: solverFee.toString(),
        dstChainId: DST_CHAIN_ID,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature
      };

      const tx = await router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params);

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

      // Compute expected request ID
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const requestedAt = block!.timestamp;
      const swapParameters = {
        sender: userAddr,
        recipient: recipientAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountOut: amountOut.toString(),
        srcChainId: srcChainId,
        dstChainId: DST_CHAIN_ID,
        verificationFee: (await router.getVerificationFeeAmount(amountIn))[0],
        solverFee: solverFee.toString(),
        nonce: await router.currentSwapRequestNonce(),
        executed: false,
        requestedAt: requestedAt,

      };

      const expectedRequestId = await router.getSwapRequestId(swapParameters);

      expect(requestId).to.equal(expectedRequestId);

      expect(await srcToken.balanceOf(userAddr)).to.equal(0);
      expect(await srcToken.balanceOf(recipientAddr)).to.equal(0);
      expect(await srcToken.balanceOf(await router.getAddress())).to.equal(amountIn + solverFee);
      expect(await srcToken.balanceOf(await permit2.getAddress())).to.equal(0);
    });

    it("should make a swap request with a valid Permit2 signature where src token is 18 decimals and dst token is 6 decimals", async () => {
      // Redeploy dstToken with 6 decimals
      dstToken = await new ERC20Token__factory(owner).deploy("RUSD", "RUSD", 6);
      await router
        .connect(owner)
        .setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());
      const amountIn = parseEther("10");
      const amountOut = BigInt(10_000_000); // 10 USDC with 6 decimals
      const solverFee = parseEther("1");
      const amountToMint = amountIn + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;
      const srcChainId = await router.getChainId();
      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);
      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };
      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOut", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };
      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
          solverFee: solverFee.toString(),
          dstChainId: DST_CHAIN_ID,
          recipient: recipientAddr,
          additionalData: "0x",
        },
      };
      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);
      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        solverFee: solverFee.toString(),
        dstChainId: DST_CHAIN_ID,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,

      };
      const tx = await router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params);

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

      // check request parameters
      const swapRequestParams = await router.getSwapRequestParameters(requestId);
      expect(swapRequestParams.amountOut).to.equal(amountOut);

      expect(await router.solverFeeRefunds(requestId)).to.equal(amountToMint - swapRequestParams.verificationFee);
    });

    it("should fail to make a swap request with an invalid Permit2 signature", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amount: amount.toString(),
          solverFee: solverFee.toString(),
          dstChainId: DST_CHAIN_ID,
          recipient: recipientAddr,
          additionalData: "0x",
        },
      };

      // Sign with a different account (owner) to make signature invalid for the user
      const invalidSignature = await owner.signTypedData(permit2Domain, permit2Types, permit2Message);

      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amount,
        amountOut: amount,
        solverFee: solverFee,
        dstChainId: DST_CHAIN_ID,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: invalidSignature,

      };

      await expect(
        router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params),
      ).to.be.revertedWithCustomError(permit2, "InvalidSigner");
    });

    it("should fail to make a swap request when the requester address does not match the Permit2 signature", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amount: amount.toString(),
          solverFee: solverFee.toString(),
          dstChainId: DST_CHAIN_ID,
          recipient: recipientAddr,
          additionalData: "0x",
        },
      };

      // Proper signature by user
      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      // But pass a different requester address (ownerAddr) - should fail
      const requestCrossChainSwapPermit2Params = {
        requester: ownerAddr, // mismatched requester
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amount,
        amountOut: amount,
        solverFee: solverFee,
        dstChainId: DST_CHAIN_ID,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,
      };

      await expect(
        router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params),
      ).to.be.revertedWithCustomError(permit2, "InvalidSigner");
    });

    it("should fail to make a swap request when the permit has expired", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      const permitNonce = 0;
      // Use a deadline that's already expired
      const permitDeadline = 0;

      const srcChainId = await router.getChainId();

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amount: amount.toString(),
          solverFee: solverFee.toString(),
          dstChainId: DST_CHAIN_ID,
          recipient: recipientAddr,
          additionalData: "0x",
        },
      };

      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amount,
        amountOut: amount,
        solverFee: solverFee,
        dstChainId: DST_CHAIN_ID,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,
      };

      await expect(
        router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params),
      ).to.be.revertedWithCustomError(permit2, "SignatureExpired");
    });

    it("should fail to make a swap request when the amount is zero", async () => {
      const amount = parseEther("0");
      const solverFee = parseEther("1");
      const amountToMint = solverFee; // mint just solver fee so approvals exist
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amount: amount.toString(), // zero amount in witness
          solverFee: solverFee.toString(),
          dstChainId: DST_CHAIN_ID,
          recipient: recipientAddr,
          additionalData: "0x",
        },
      };

      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amount,
        amountOut: amount,
        solverFee: solverFee,
        dstChainId: DST_CHAIN_ID,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,

      };

      await expect(
        router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params),
      ).to.be.revertedWithCustomError(router, "ZeroAmount");
    });

    it("should fail to make a swap request when the recipient address is zero", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amount: amount.toString(),
          solverFee: solverFee.toString(),
          dstChainId: DST_CHAIN_ID,
          recipient: ZeroAddress,
          additionalData: "0x",
        },
      };

      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amount,
        amountOut: amount,
        solverFee: solverFee,
        dstChainId: DST_CHAIN_ID,
        recipient: ZeroAddress,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,

      };

      await expect(
        router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params),
      ).to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("should fail to make a swap request when the destination chain ID is not permitted", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();
      const notPermittedDstChain = DST_CHAIN_ID + 1;

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amount: amount.toString(),
          solverFee: solverFee.toString(),
          dstChainId: notPermittedDstChain,
          recipient: recipientAddr,
          additionalData: "0x",
        },
      };

      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amount,
        amountOut: amount,
        solverFee: solverFee,
        dstChainId: notPermittedDstChain,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,

      };

      await expect(
        router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params),
      ).to.be.revertedWithCustomError(router, "DestinationChainIdNotSupported");
    });

    it("should fail to make a swap request when there is no token mapping for the destination chain ID and token", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();
      const newDstChain = 999;

      // Permit the new destination chain but DO NOT set token mapping for it
      await router.connect(owner).permitDestinationChainId(newDstChain);

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      const permit2Domain = {
        name: "Permit2",
        chainId: srcChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "SwapRequestWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        SwapRequestWitness: [
          { name: "router", type: "address" },
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "solverFee", type: "uint256" },
          { name: "dstChainId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const permit2Message = {
        permitted: {
          token: await srcToken.getAddress(),
          amount: amountToMint.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          router: await router.getAddress(),
          tokenIn: await srcToken.getAddress(),
          tokenOut: await dstToken.getAddress(),
          amount: amount.toString(),
          solverFee: solverFee.toString(),
          dstChainId: newDstChain,
          recipient: recipientAddr,
          additionalData: "0x",
        },
      };

      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amount,
        amountOut: amount,
        solverFee: solverFee,
        dstChainId: newDstChain,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,

      };

      await expect(
        router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params),
      ).to.be.revertedWithCustomError(router, "TokenNotSupported");
    });
  });

  describe("relayTokensPermit2", function () {
    it("should relay tokens with a valid Permit2 signature when src token is 6 decimals and dst token is 8 decimals", async () => {
      // Redeploy srcToken with 6 decimals and dstToken with 8 decimals
      srcToken = await new ERC20Token__factory(owner).deploy("USDC", "USDC", 6);
      dstToken = await new ERC20Token__factory(owner).deploy("RUSD", "RUSD", 8);

      const amountOut = BigInt(10_000_000); // 10 USDC with 6 decimals
      const permitNonce = 0;
      const permitDeadline = MaxUint256;
      const nonce = 1;

      const srcChainId = 1; // Example: source chain
      const dstChainId = await router.getChainId(); // current chain as destination

      const preHooks = EMPTY_HOOKS.preHooks;
      const postHooks = EMPTY_HOOKS.postHooks;

      // Replicate keccak256(abi.encode(preHooks)) and keccak256(abi.encode(postHooks))
      const preHooksHash = keccak256(AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,bytes,uint256)[]"], 
        [preHooks]
      ));
      const postHooksHash = keccak256(AbiCoder.defaultAbiCoder().encode(
        ["tuple(address,bytes,uint256)[]"], 
        [postHooks]
      ));

      // Pre-compute valid requestId
      const abiCoder = new AbiCoder();
      const requestId: string = keccak256(
        abiCoder.encode(
          ["address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256"],
          [
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amountOut,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );

      // Mint tokenOut for testing
      await dstToken.mint(solverAddr, amountOut);
      await dstToken.connect(solver).approve(await permit2.getAddress(), MaxUint256);

      // Generate Permit2 signature with relay witness
      const permit2Domain = {
        name: "Permit2",
        chainId: dstChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "RelayerWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        RelayerWitness: [
          { name: "requestId", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const additionalData = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [solverRefundAddr]);

      const permit2Message = {
        permitted: {
          token: await dstToken.getAddress(),
          amount: amountOut.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          requestId: requestId,
          recipient: recipientAddr,
          additionalData: additionalData,
        },
      };

      const signature = await solver.signTypedData(permit2Domain, permit2Types, permit2Message);

      const relayTokensPermit2Params = {
        solver: solverAddr,
        solverRefundAddress: solverRefundAddr,
        requestId: requestId,
        sender: userAddr,
        recipient: recipientAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountOut: amountOut,
        srcChainId: srcChainId,
        nonce: nonce,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,
        
      };

      // Relay tokens using Permit2 and fulfill the swap request

      await expect(router.relayTokensPermit2(relayTokensPermit2Params))
        .to.emit(router, "SwapRequestFulfilled")
        .withArgs(requestId, srcChainId, dstChainId);

      // Check that the recipient received the tokens
      const recipientBalance = await dstToken.balanceOf(recipientAddr);
      expect(recipientBalance).to.equal(amountOut);

      expect(await dstToken.balanceOf(await router.getAddress())).to.equal(0);
      expect(await dstToken.balanceOf(await permit2Relayer.getAddress())).to.equal(0);
    });

    it("should relay tokens with a valid Permit2 signature and mark request as fulfilled", async () => {
      const amountOut = parseEther("10");
      const permitNonce = 0;
      const permitDeadline = MaxUint256;
      const nonce = 1;

      const srcChainId = 1; // Example: source chain
      const dstChainId = await router.getChainId(); // current chain as destination

      // Pre-compute valid requestId
      const abiCoder = new AbiCoder();
      const requestId: string = keccak256(
        abiCoder.encode(
          ["address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256"],
          [
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amountOut,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );

      // Mint tokenOut for testing
      await dstToken.mint(solverAddr, amountOut);
      await dstToken.connect(solver).approve(await permit2.getAddress(), MaxUint256);

      // Generate Permit2 signature with relay witness
      const permit2Domain = {
        name: "Permit2",
        chainId: dstChainId,
        verifyingContract: await permit2.getAddress(),
      };

      const permit2Types = {
        PermitWitnessTransferFrom: [
          { name: "permitted", type: "TokenPermissions" },
          { name: "spender", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "witness", type: "RelayerWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        RelayerWitness: [
          { name: "requestId", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "additionalData", type: "bytes" },
        ],
      };

      const additionalData = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [solverRefundAddr]);

      const permit2Message = {
        permitted: {
          token: await dstToken.getAddress(),
          amount: amountOut.toString(),
        },
        spender: await permit2Relayer.getAddress(),
        nonce: permitNonce,
        deadline: permitDeadline,
        witness: {
          requestId: requestId,
          recipient: recipientAddr,
          additionalData: additionalData,
        },
      };

      const signature = await solver.signTypedData(permit2Domain, permit2Types, permit2Message);

      const relayTokensPermit2Params = {
        solver: solverAddr,
        solverRefundAddress: solverRefundAddr,
        requestId: requestId,
        sender: userAddr,
        recipient: recipientAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountOut: amountOut,
        srcChainId: srcChainId,
        nonce: nonce,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,
      };

      // Relay tokens using Permit2 and fulfill the swap request

      await expect(router.relayTokensPermit2(relayTokensPermit2Params))
        .to.emit(router, "SwapRequestFulfilled")
        .withArgs(requestId, srcChainId, dstChainId);

      // Check that the recipient received the tokens
      const recipientBalance = await dstToken.balanceOf(recipientAddr);
      expect(recipientBalance).to.equal(amountOut);

      expect(await dstToken.balanceOf(await router.getAddress())).to.equal(0);
      expect(await dstToken.balanceOf(await permit2Relayer.getAddress())).to.equal(0);
    });
  });
});
