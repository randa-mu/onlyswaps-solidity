import {
  Router,
  Router__factory,
  MockRouterV2__factory,
  ERC20Token,
  ERC20Token__factory,
  BLSBN254SignatureScheme,
  BLSBN254SignatureScheme__factory,
  UUPSProxy__factory,
  Permit2Relayer,
  Permit2Relayer__factory,
  Permit2,
  Permit2__factory,
  src,
} from "../../typechain-types";
import { extractSingleLog } from "./utils/utils";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { exec } from "child_process";
import { AbiCoder, parseEther, keccak256, toUtf8Bytes, ZeroAddress, MaxUint256 } from "ethers";
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
    // Deploy Permit2Relayer
    permit2Relayer = await new Permit2Relayer__factory(owner).deploy();
    await permit2Relayer.waitForDeployment();

    // Deploy Permit2
    permit2 = await new Permit2__factory(owner).deploy();
    await permit2.waitForDeployment();

    // Set Permit2 address in Permit2Relayer
    await permit2Relayer.connect(owner).setPermit2Address(await permit2.getAddress());

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
        await permit2Relayer.getAddress(),
        VERIFICATION_FEE_BPS,
      ]),
    );
    await routerProxy.waitForDeployment();

    // Attach Router interface to proxy address
    const routerAttached = Router__factory.connect(await routerProxy.getAddress(), owner);
    router = routerAttached;

    // Router contract configuration
    await router.connect(owner).permitDestinationChainId(DST_CHAIN_ID);
    await router.connect(owner).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());
  });

  describe("Request cross chain swap with Permit2", function () {
    it("should make a swap request with a valid Permit2 signature and emit swap requested event", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
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
          { name: "witness", type: "RelayerWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        RelayerWitness: [
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

      await expect(
        router.requestCrossChainSwapPermit2(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          solverFee,
          DST_CHAIN_ID,
          userAddr,
          recipientAddr,
          permitNonce,
          permitDeadline,
          signature,
        ),
      ).to.emit(router, "SwapRequested");
    });

    it("should make a swap request with a valid Permit2 signature and emit swap requested event with the correct request id", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
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
          { name: "witness", type: "RelayerWitness" },
        ],
        TokenPermissions: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        RelayerWitness: [
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

      const tx = await router.requestCrossChainSwapPermit2(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        solverFee,
        DST_CHAIN_ID,
        userAddr,
        recipientAddr,
        permitNonce,
        permitDeadline,
        signature,
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

      // Compute expected request ID
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      const requestedAt = block!.timestamp;
      const swapParameters = {
        sender: userAddr,
        recipient: recipientAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountOut: (await router.getVerificationFeeAmount(amount))[1],
        srcChainId: srcChainId,
        dstChainId: DST_CHAIN_ID,
        verificationFee: (await router.getVerificationFeeAmount(amount))[0],
        solverFee: solverFee,
        nonce: await router.currentSwapRequestNonce(),
        executed: false,
        requestedAt: requestedAt,
      };

      const expectedRequestId = await router.getSwapRequestId(swapParameters);

      expect(requestId).to.equal(expectedRequestId);

      expect(await srcToken.balanceOf(userAddr)).to.equal(0);
      expect(await srcToken.balanceOf(recipientAddr)).to.equal(0);
      expect(await srcToken.balanceOf(await router.getAddress())).to.equal(amount + solverFee);
      expect(await srcToken.balanceOf(await permit2.getAddress())).to.equal(0);
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
        { name: "witness", type: "RelayerWitness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      RelayerWitness: [
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

      await expect(
      router.requestCrossChainSwapPermit2(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        solverFee,
        DST_CHAIN_ID,
        userAddr,
        recipientAddr,
        permitNonce,
        permitDeadline,
        invalidSignature,
      ),
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
        { name: "witness", type: "RelayerWitness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      RelayerWitness: [
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
      await expect(
      router.requestCrossChainSwapPermit2(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        solverFee,
        DST_CHAIN_ID,
        ownerAddr, // mismatched requester
        recipientAddr,
        permitNonce,
        permitDeadline,
        signature,
      ),
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
        { name: "witness", type: "RelayerWitness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      RelayerWitness: [
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

      await expect(
      router.requestCrossChainSwapPermit2(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        solverFee,
        DST_CHAIN_ID,
        userAddr,
        recipientAddr,
        permitNonce,
        permitDeadline,
        signature,
      ),
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
        { name: "witness", type: "RelayerWitness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      RelayerWitness: [
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

      await expect(
      router.requestCrossChainSwapPermit2(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        solverFee,
        DST_CHAIN_ID,
        userAddr,
        recipientAddr,
        permitNonce,
        permitDeadline,
        signature,
      ),
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
        { name: "witness", type: "RelayerWitness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      RelayerWitness: [
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

      await expect(
      router.requestCrossChainSwapPermit2(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        solverFee,
        DST_CHAIN_ID,
        userAddr,
        ZeroAddress,
        permitNonce,
        permitDeadline,
        signature,
      ),
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
        { name: "witness", type: "RelayerWitness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      RelayerWitness: [
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

      await expect(
      router.requestCrossChainSwapPermit2(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        solverFee,
        notPermittedDstChain,
        userAddr,
        recipientAddr,
        permitNonce,
        permitDeadline,
        signature,
      ),
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
        { name: "witness", type: "RelayerWitness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      RelayerWitness: [
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

      await expect(
      router.requestCrossChainSwapPermit2(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        solverFee,
        newDstChain,
        userAddr,
        recipientAddr,
        permitNonce,
        permitDeadline,
        signature,
      ),
      ).to.be.revertedWithCustomError(router, "TokenNotSupported");
    });
  });
});
