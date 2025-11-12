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
  Permit2__factory,
} from "../../typechain-types";
import { extractSingleLog } from "./utils/utils";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { AbiCoder, parseEther, keccak256, toUtf8Bytes, ZeroAddress } from "ethers";
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

  describe("Router Initialization", function () {
    it("should return correct contract version", async () => {
      const version = await router.getVersion();
      expect(version).to.equal("1.1.0");
    });

    it("should get minimum contract upgrade delay correctly", async () => {
      const minDelay = await router.getMinimumContractUpgradeDelay();
      expect(minDelay).to.equal(172800); // 2 days in seconds
    });

    it("should revert initialize if _verificationFeeBps is zero or exceeds MAX_FEE_BPS", async () => {
      const routerImpl = await ethers.getContractFactory("Router", owner);
      const implementation = await routerImpl.deploy();
      await implementation.waitForDeployment();

      const proxyFactory = await ethers.getContractFactory("UUPSProxy", owner);

      // Case 1: _verificationFeeBps is zero
      await expect(
        proxyFactory.deploy(
          await implementation.getAddress(),
          routerImpl.interface.encodeFunctionData("initialize", [
            ownerAddr,
            await swapBn254SigScheme.getAddress(),
            await upgradeBn254SigScheme.getAddress(),
            0, // invalid fee
          ]),
        ),
      ).to.be.revertedWithCustomError(implementation, "InvalidFeeBps");

      // Case 2: _verificationFeeBps exceeds MAX_FEE_BPS
      const maxFeeBps = await implementation.MAX_FEE_BPS();
      await expect(
        proxyFactory.deploy(
          await implementation.getAddress(),
          routerImpl.interface.encodeFunctionData("initialize", [
            ownerAddr,
            await swapBn254SigScheme.getAddress(),
            await upgradeBn254SigScheme.getAddress(),
            Number(maxFeeBps) + 1, // invalid fee
          ]),
        ),
      ).to.be.revertedWithCustomError(implementation, "InvalidFeeBps");
    });

    it("should revert initialize if _contractUpgradeBlsValidator or _swapRequestBlsValidator is zero address", async () => {
      const routerImpl = await ethers.getContractFactory("Router", owner);
      const implementation = await routerImpl.deploy();
      await implementation.waitForDeployment();

      const proxyFactory = await ethers.getContractFactory("UUPSProxy", owner);

      // Case 1: _contractUpgradeBlsValidator is zero address
      await expect(
        proxyFactory.deploy(
          await implementation.getAddress(),
          routerImpl.interface.encodeFunctionData("initialize", [
            ownerAddr,
            await swapBn254SigScheme.getAddress(),
            ZeroAddress, // invalid validator
            VERIFICATION_FEE_BPS,
          ]),
        ),
      ).to.be.revertedWithCustomError(implementation, "ZeroAddress");

      // Case 2: _swapRequestBlsValidator is zero address
      await expect(
        proxyFactory.deploy(
          await implementation.getAddress(),
          routerImpl.interface.encodeFunctionData("initialize", [
            ownerAddr,
            ZeroAddress, // invalid validator
            await upgradeBn254SigScheme.getAddress(),
            VERIFICATION_FEE_BPS,
          ]),
        ),
      ).to.be.revertedWithCustomError(implementation, "ZeroAddress");
    });

    it("should return non-zero address for the swap request BLS validator", async () => {
      const validatorAddr = await router.getSwapRequestBlsValidator();
      expect(validatorAddr).to.not.equal(ZeroAddress);
    });
  });

  describe("Token Mapping", function () {
    it("should revert removeTokenMapping if called by non-admin", async () => {
      const dstChainId = 137;

      // Try to remove mapping as a non-admin
      await expect(
        router.connect(user).removeTokenMapping(dstChainId, dstToken, srcToken),
      ).to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    });

    it("should get token mapping correctly", async () => {
      const dstChainId = DST_CHAIN_ID;
      const isMapped = await router.isDstTokenMapped(
        await srcToken.getAddress(),
        dstChainId,
        await dstToken.getAddress(),
      );
      expect(isMapped).to.be.true;

      expect(await router.getTokenMapping(await srcToken.getAddress(), dstChainId)).to.deep.equal(
        [await dstToken.getAddress()]
      );
    });

    it("should revert removeTokenMapping if destination chain is not permitted", async () => {
      const dstChainId = 999; // not permitted

      await expect(
        router.connect(owner).removeTokenMapping(dstChainId, dstToken, srcToken),
      ).to.be.revertedWithCustomError(router, "DestinationChainIdNotSupported");
    });

    it("should revert removeTokenMapping if token mapping does not exist", async () => {
      const dstChainId = 137;

      await expect(
        router.connect(owner).removeTokenMapping(dstChainId, srcToken, srcToken),
      ).to.be.revertedWithCustomError(router, "TokenNotSupported");
    });

    it("should remove token mapping if called by admin and mapping exists", async () => {
      const dstChainId = 138;

      await router.connect(owner).permitDestinationChainId(dstChainId);
      expect(await router.getAllowedDstChainId(dstChainId)).to.be.true;

      // Set up mapping first
      await router.connect(owner).setTokenMapping(dstChainId, dstToken, srcToken);

      await expect(router.connect(owner).removeTokenMapping(dstChainId, dstToken, srcToken))
        .to.emit(router, "TokenMappingRemoved")
        .withArgs(dstChainId, dstToken, srcToken);

      // Mapping should not exist anymore
      expect(await router.isDstTokenMapped(srcToken, dstChainId, dstToken)).to.be.false;
    });

    it("should remove the token mapping for a specific destination chain", async () => {
      // Ensure the token mapping exists before removal
      expect(await router.isDstTokenMapped(await srcToken.getAddress(), DST_CHAIN_ID, await dstToken.getAddress())).to
        .be.true;

      // Remove the token mapping
      await router
        .connect(owner)
        .removeTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());

      // Check that the token mapping has been removed
      expect(await router.isDstTokenMapped(await srcToken.getAddress(), DST_CHAIN_ID, await dstToken.getAddress())).to
        .be.false;
    });

    it("should return false for isDstTokenMapped if the token mapping does not exist", async () => {
      const nonExistentDstToken = ZeroAddress;

      // Check that the token mapping does not exist
      expect(await router.isDstTokenMapped(await srcToken.getAddress(), DST_CHAIN_ID, nonExistentDstToken)).to.be.false;
    });

    it("should map two token addresses to a src token on a single dst chain id", async () => {
      const secondDstToken = await new ERC20Token__factory(owner).deploy("RUSD2", "RUSD2", 18);

      // First destination token already mapped in beforeEach
      await expect(
        router.connect(owner).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress()),
      ).to.be.revertedWithCustomError(router, "TokenMappingAlreadyExists");

      // Map second destination token
      await router
        .connect(owner)
        .setTokenMapping(DST_CHAIN_ID, await secondDstToken.getAddress(), await srcToken.getAddress());
      expect(
        await router.isDstTokenMapped(await srcToken.getAddress(), DST_CHAIN_ID, await secondDstToken.getAddress()),
      ).to.be.true;
    });

    it("should revert if dst chain id is not permitted", async () => {
      const secondDstToken = await new ERC20Token__factory(owner).deploy("RUSD2", "RUSD2", 18);
      const dstChainId = 1000; // Not permitted in beforeEach

      // First destination token already mapped in beforeEach
      await expect(
        router.connect(owner).setTokenMapping(dstChainId, await dstToken.getAddress(), await srcToken.getAddress()),
      ).to.be.revertedWithCustomError(router, "DestinationChainIdNotSupported");

      expect(await router.isDstTokenMapped(await srcToken.getAddress(), dstChainId, await secondDstToken.getAddress()))
        .to.be.false;
    });

    it("should map two tokens on different dst chain ids to a single src token", async () => {
      const thirdDstToken = await new ERC20Token__factory(owner).deploy("RUSD3", "RUSD3", 18);
      const fourthDstToken = await new ERC20Token__factory(owner).deploy("RUSD4", "RUSD4", 18);
      const secondDstChainId = DST_CHAIN_ID + 1;

      // Support the second destination chain ID
      await router.connect(owner).permitDestinationChainId(secondDstChainId);

      // Map first destination token
      await router
        .connect(owner)
        .setTokenMapping(DST_CHAIN_ID, await thirdDstToken.getAddress(), await srcToken.getAddress());
      expect(await router.isDstTokenMapped(await srcToken.getAddress(), DST_CHAIN_ID, await thirdDstToken.getAddress()))
        .to.be.true;

      // Map second destination token on a different chain ID
      await router
        .connect(owner)
        .setTokenMapping(secondDstChainId, await fourthDstToken.getAddress(), await srcToken.getAddress());
      expect(
        await router.isDstTokenMapped(await srcToken.getAddress(), secondDstChainId, await fourthDstToken.getAddress()),
      ).to.be.true;
    });
  });

  describe("Swap Requests", function () {
    it("should make a swap request and emit message", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      await expect(
        router
          .connect(user)
          .requestCrossChainSwap(
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            amount,
            solverFee,
            DST_CHAIN_ID,
            recipientAddr,
          ),
      ).to.emit(router, "SwapRequested");
    });

    it("should make a swap request and emit message with 6 decimals src token and 18 decimals dst token", async () => {
      // Deploy tokens with different decimals
      const srcToken6Decimals = await new ERC20Token__factory(owner).deploy("RUSD6", "RUSD6", 6);
      const dstToken18Decimals = await new ERC20Token__factory(owner).deploy("RUSD18", "RUSD18", 18);
      // Set up token mapping
      await router
        .connect(owner)
        .setTokenMapping(DST_CHAIN_ID, await dstToken18Decimals.getAddress(), await srcToken6Decimals.getAddress());
      const amountIn = BigInt(10_000_000); // 10 RUSD6 with 6 decimals
      const amountOut = BigInt(10_000_000_000_000_000_000); // 10 RUSD18 with 18 decimals
      const solverFee = BigInt(1_000_000); // 1 RUSD6 with 6 decimals
      await srcToken6Decimals.mint(userAddr, amountIn + solverFee);
      await srcToken6Decimals.connect(user).approve(router.getAddress(), amountIn + solverFee);
      // Make swap request
      const tx = await router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken6Decimals.getAddress(),
          await dstToken18Decimals.getAddress(),
          amountIn,
          amountOut,
          solverFee,
          DST_CHAIN_ID,
          recipientAddr,
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

      // check request parameters
      const swapRequestParams = await router.getSwapRequestParameters(requestId);
      expect(swapRequestParams.amountOut).to.equal(amountOut);
    });

    it("should make a swap request and emit message with 18 decimals src token and 6 decimals dst token", async () => {
      // Deploy tokens with different decimals
      const srcToken18Decimals = await new ERC20Token__factory(owner).deploy("RUSD18", "RUSD18", 18);
      const dstToken6Decimals = await new ERC20Token__factory(owner).deploy("RUSD6", "RUSD6", 6);

      // Set up token mapping
      await router
        .connect(owner)
        .setTokenMapping(DST_CHAIN_ID, await dstToken6Decimals.getAddress(), await srcToken18Decimals.getAddress());
      const amountIn = BigInt(10_000_000_000_000_000_000); // 10 RUSD18 with 18 decimals
      const amountOut = BigInt(10_000_000); // 10 RUSD6 with 6 decimals
      const solverFee = BigInt(1_000_000_000_000_000); // 0.001 RUSD18 with 18 decimals
      await srcToken18Decimals.mint(userAddr, amountIn + solverFee);
      await srcToken18Decimals.connect(user).approve(router.getAddress(), amountIn + solverFee);
      // Make swap request
      const tx = await router

        .connect(user)
        .requestCrossChainSwap(
          await srcToken18Decimals.getAddress(),
          await dstToken6Decimals.getAddress(),
          amountIn,
          amountOut,
          solverFee,
          DST_CHAIN_ID,
          recipientAddr,
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
      // check request parameters
      const swapRequestParams = await router.getSwapRequestParameters(requestId);
      expect(swapRequestParams.amountOut).to.equal(amountOut);
    });

    it("should revert if fee is too low", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("0"); // Set fee lower than the required swap fee
      const amountToMint = amount + solverFee;

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      await expect(
        router
          .connect(user)
          .requestCrossChainSwap(
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            amount,
            solverFee,
            DST_CHAIN_ID,
            recipientAddr,
          ),
      ).to.be.revertedWithCustomError(router, "FeeTooLow");
    });

    it("should update the total swap request fee for unfulfilled request", async () => {
      const amount = parseEther("5");
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

      const newFee = parseEther("1.5");
      await srcToken.mint(user.address, newFee - solverFee);
      await srcToken.connect(user).approve(await router.getAddress(), newFee - solverFee);

      expect(await srcToken.balanceOf(userAddr)).to.equal(newFee - solverFee);

      // Check: only sender can update fee
      await expect(
        router.connect(solver).updateSolverFeesIfUnfulfilled(requestId, newFee),
      ).to.be.revertedWithCustomError(router, "UnauthorisedCaller");

      // Check: newFee must be greater than current solverFee
      await expect(
        router.connect(user).updateSolverFeesIfUnfulfilled(requestId, solverFee),
      ).to.be.revertedWithCustomError(router, "NewFeeTooLow");

      await expect(router.connect(user).updateSolverFeesIfUnfulfilled(requestId, newFee)).to.emit(
        router,
        "SwapRequestSolverFeeUpdated",
      );

      expect(await srcToken.balanceOf(userAddr)).to.equal(0);

      const swapRequestParams = await router.getSwapRequestParameters(requestId);
      expect(swapRequestParams.solverFee).to.equal(newFee);
    });
  });

  describe("Verification Fee Withdrawals, Solver Rebalancing and Relay Tokens", function () {
    it("should block non-owner from withdrawing fees and revert with AccessControlUnauthorizedAccount for caller address and ADMIN_ROLE", async () => {
      await expect(router.connect(user).withdrawVerificationFee(await srcToken.getAddress(), user.address)).to.be
        .reverted;
    });

    it("should allow owner to withdraw verification fees", async () => {
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

      const before = await srcToken.balanceOf(owner.address);

      await expect(router.connect(owner).withdrawVerificationFee(await srcToken.getAddress(), ownerAddr)).to.emit(
        router,
        "VerificationFeeWithdrawn",
      );

      const after = await srcToken.balanceOf(ownerAddr);
      expect(after).to.be.gt(before);

      expect(await router.getTotalVerificationFeeBalance(await srcToken.getAddress())).to.equal(0);

      const swapRequestParams = await router.getSwapRequestParameters(requestId);
      expect(await srcToken.balanceOf(await router.getAddress())).to.equal(
        amount + swapRequestParams.solverFee - swapRequestParams.verificationFee,
      );
    });

    it("should rebalance solver and transfer correct amount", async () => {
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

      const [, messageAsG1Bytes] = await router.swapRequestParametersToBytes(requestId, solver.address);
      // Remove "0x" prefix if present
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
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

    it("should rebalance solver and transfer correct amount in the src token decimals when src token is 6 decimals and dst token is 8 decimals", async () => {
      // Deploy tokens with different decimals
      const srcToken6Decimals = await new ERC20Token__factory(owner).deploy("RUSD6", "RUSD6", 6);
      const dstToken8Decimals = await new ERC20Token__factory(owner).deploy("RUSD8", "RUSD8", 8);
      // Set up token mapping
      await router
        .connect(owner)
        .setTokenMapping(DST_CHAIN_ID, await dstToken8Decimals.getAddress(), await srcToken6Decimals.getAddress());
      // Create token swap request on source chain
      const amountIn = BigInt(10_000_000); // 10 RUSD6 with 6 decimals
      const solverFee = BigInt(1_000_000); // 1 RUSD6 with 6 decimals
      const amountOut = BigInt(1_000_000_000); // 10 RUSD8 with 8 decimals
      const amountToMint = amountIn + solverFee;
      await srcToken6Decimals.mint(userAddr, amountToMint);
      await srcToken6Decimals.connect(user).approve(router.getAddress(), amountToMint);
      const tx = await router

        .connect(user)
        .requestCrossChainSwap(
          await srcToken6Decimals.getAddress(),
          await dstToken8Decimals.getAddress(),
          amountIn,
          amountOut,
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
      const [, messageAsG1Bytes] = await router.swapRequestParametersToBytes(requestId, solver.address);
      // Remove "0x" prefix if present
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
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

      // ensure that the router has enough liquidity to pay solver
      expect(await srcToken6Decimals.balanceOf(await router.getAddress())).to.be.greaterThanOrEqual(
        await router.solverFeeRefunds(requestId),
      );

      expect(await srcToken6Decimals.balanceOf(await router.getAddress())).to.be.greaterThanOrEqual(
        amountIn + swapRequestParams.solverFee,
      );

      const before = await srcToken6Decimals.balanceOf(solverAddr);

      expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(0);
      expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(1);

      // Rebalance Solver
      await router.connect(owner).rebalanceSolver(solver.address, requestId, sigBytes);
      const after = await srcToken6Decimals.balanceOf(solverAddr);
      expect(after - before).to.equal(amountIn + swapRequestParams.solverFee - swapRequestParams.verificationFee);
      expect(await srcToken6Decimals.balanceOf(await router.getAddress())).to.be.equal(
        swapRequestParams.verificationFee,
      );

      expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(1);
      expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(0);
    });

    it("should rebalance solver and transfer correct amount in the src token decimals when src token is 18 decimals and dst token is 8 decimals", async () => {
      // Deploy tokens with different decimals
      const srcToken18Decimals = await new ERC20Token__factory(owner).deploy("RUSD18", "RUSD18", 18);
      const dstToken8Decimals = await new ERC20Token__factory(owner).deploy("RUSD8", "RUSD8", 8);
      // Set up token mapping
      await router
        .connect(owner)
        .setTokenMapping(DST_CHAIN_ID, await dstToken8Decimals.getAddress(), await srcToken18Decimals.getAddress());
      // Create token swap request on source chain
      const amountIn = BigInt(10_000_000_000_000_000_000); // 10 RUSD18 with 18 decimals
      const solverFee = BigInt(1_000_000_000_000_000); // 0.001 RUSD18 with 18 decimals
      const amountOut = BigInt(1_000_000_000); // 10 RUSD8 with 8 decimals
      const amountToMint = amountIn + solverFee;
      await srcToken18Decimals.mint(userAddr, amountToMint);
      await srcToken18Decimals.connect(user).approve(router.getAddress(), amountToMint);
      const tx = await router

        .connect(user)
        .requestCrossChainSwap(
          await srcToken18Decimals.getAddress(),
          await dstToken8Decimals.getAddress(),
          amountIn,
          amountOut,
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
      const [, messageAsG1Bytes] = await router.swapRequestParametersToBytes(requestId, solver.address);
      // Remove "0x" prefix if present
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
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

      // ensure that the router has enough liquidity to pay solver
      expect(await srcToken18Decimals.balanceOf(await router.getAddress())).to.be.greaterThanOrEqual(
        await router.solverFeeRefunds(requestId),
      );

      expect(await srcToken18Decimals.balanceOf(await router.getAddress())).to.be.greaterThanOrEqual(
        amountIn + swapRequestParams.solverFee,
      );

      const before = await srcToken18Decimals.balanceOf(solverAddr);

      expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(0);
      expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(1);

      // Rebalance Solver
      await router.connect(owner).rebalanceSolver(solver.address, requestId, sigBytes);
      const after = await srcToken18Decimals.balanceOf(solverAddr);
      expect(after - before).to.equal(amountIn + swapRequestParams.solverFee - swapRequestParams.verificationFee);
      expect(await srcToken18Decimals.balanceOf(await router.getAddress())).to.be.equal(
        swapRequestParams.verificationFee,
      );

      expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(1);
      expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(0);
    });

    it("should relay tokens and store a receipt", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

      // Mint tokens for user
      await dstToken.mint(solverAddr, amount);

      // Approve Router to spend user's tokens
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

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
            amount,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );

      // Relay tokens
      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
          ),
      ).to.emit(router, "SwapRequestFulfilled");

      // Check recipient balance after transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(amount);

      // Check receipt
      const swapRequestReceipt = await router.getSwapRequestReceipt(requestId);
      const [, , , , , fulfilled, solverFromReceipt, , amountOut] = swapRequestReceipt;

      expect(fulfilled).to.be.true;
      expect(amountOut).to.equal(amount);
      // solver address in the receipt should match the solver who called relayTokens
      expect(solverFromReceipt).to.equal(solverRefundAddr);
      expect(solverAddr).to.not.equal(solverRefundAddr);

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);

      await expect(
        router
          .connect(user)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
          ),
      ).to.revertedWithCustomError(router, "AlreadyFulfilled()");

      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);
    });

    it("should relay tokens and store a receipt with 6 decimals src token and 18 decimals dst token", async () => {
      // Deploy tokens with different decimals
      const srcToken6Decimals = await new ERC20Token__factory(owner).deploy("RUSD6", "RUSD6", 6);
      const dstToken18Decimals = await new ERC20Token__factory(owner).deploy("RUSD18", "RUSD18", 18);

      const amountOut = BigInt(10_000_000_000_000_000_000); // 10 RUSD18 with 18 decimals
      const srcChainId = 1;
      const dstChainId = await router.getChainId();
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken18Decimals.balanceOf(recipientAddr)).to.equal(0);

      // Mint tokens for user
      await dstToken18Decimals.mint(solverAddr, amountOut);

      // Approve Router to spend user's tokens
      await dstToken18Decimals.connect(solver).approve(await router.getAddress(), amountOut);

      // Pre-compute valid requestId
      const abiCoder = new AbiCoder();
      const requestId: string = keccak256(
        abiCoder.encode(
          ["address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256"],
          [
            userAddr,
            recipientAddr,
            await srcToken6Decimals.getAddress(),
            await dstToken18Decimals.getAddress(),
            amountOut,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );

      // Relay tokens
      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            recipientAddr,
            await srcToken6Decimals.getAddress(),
            await dstToken18Decimals.getAddress(),
            amountOut,
            srcChainId,
            nonce,
          ),
      ).to.emit(router, "SwapRequestFulfilled");

      // Check recipient balance after transfer
      expect(await dstToken18Decimals.balanceOf(recipientAddr)).to.equal(amountOut);

      // Check receipt
      const swapRequestReceipt = await router.getSwapRequestReceipt(requestId);
      const [, , , , , fulfilled, solverFromReceipt, , amountOutReceived] = swapRequestReceipt;

      expect(fulfilled).to.be.true;
      expect(amountOut).to.equal(amountOutReceived);
      // solver address in the receipt should match the solver refund address specified in call to relayTokens
      expect(solverFromReceipt).to.equal(solverRefundAddr);
      expect(solverAddr).to.not.equal(solverRefundAddr);

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);
    });

    it("should relay tokens and store a receipt with 18 decimals src token and 6 decimals dst token", async () => {
      // Deploy tokens with different decimals
      const srcToken18Decimals = await new ERC20Token__factory(owner).deploy("RUSD18", "RUSD18", 18);
      const dstToken6Decimals = await new ERC20Token__factory(owner).deploy("RUSD6", "RUSD6", 6);

      const amountOut = BigInt(10_000_000); // 10 RUSD6 with 6 decimals
      const srcChainId = 1;
      const dstChainId = await router.getChainId();
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken6Decimals.balanceOf(recipientAddr)).to.equal(0);

      // Mint tokens for user
      await dstToken6Decimals.mint(solverAddr, amountOut);

      // Approve Router to spend user's tokens
      await dstToken6Decimals.connect(solver).approve(await router.getAddress(), amountOut);

      // Pre-compute valid requestId
      const abiCoder = new AbiCoder();
      const requestId: string = keccak256(
        abiCoder.encode(
          ["address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256"],
          [
            userAddr,
            recipientAddr,
            await srcToken18Decimals.getAddress(),
            await dstToken6Decimals.getAddress(),
            amountOut,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );

      // Relay tokens
      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            recipientAddr,
            await srcToken18Decimals.getAddress(),
            await dstToken6Decimals.getAddress(),
            amountOut,
            srcChainId,
            nonce,
          ),
      ).to.emit(router, "SwapRequestFulfilled");

      // Check recipient balance after transfer
      expect(await dstToken6Decimals.balanceOf(recipientAddr)).to.equal(amountOut);

      // Check receipt
      const swapRequestReceipt = await router.getSwapRequestReceipt(requestId);
      const [, , , , , fulfilled, solverFromReceipt, , amountOutReceived] = swapRequestReceipt;

      expect(fulfilled).to.be.true;
      expect(amountOut).to.equal(amountOutReceived);
      // solver address in the receipt should match the solver refund address specified in call to relayTokens
      expect(solverFromReceipt).to.equal(solverRefundAddr);
      expect(solverAddr).to.not.equal(solverRefundAddr);

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);
    });

    it("should revert relay tokens if solverRefundAddress is zero address", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 1;

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
            amount,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );

      // Relay tokens
      await expect(
        router.connect(solver).relayTokens(
          ZeroAddress, // zero address in place of solverRefundAddress should revert
          requestId,
          userAddr,
          recipientAddr,
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          srcChainId,
          nonce,
        ),
      ).to.revertedWithCustomError(router, "ZeroAddress()");

      // Check recipient balance after transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0n);

      // Check receipt
      const [, , , , , fulfilled, solverFromReceipt, , amountOut] = await router.swapRequestReceipts(requestId);
      expect(fulfilled).to.be.false;
      expect(amountOut).to.equal(0n);
      expect(solverFromReceipt).to.equal(ZeroAddress);

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(false);
      expect((await router.getFulfilledTransfers()).length).to.be.equal(0n);

      // Mint tokens for user
      await dstToken.mint(solverAddr, amount);

      // Approve Router to spend user's tokens
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

      // Relay tokens
      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
          ),
      ).to.emit(router, "SwapRequestFulfilled");

      // Check fulfilled transfers
      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);

      // Check recipient balance after transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(amount);
    });

    it("should revert if source chain id is the same as the destination chain id", async () => {
      const amount = parseEther("10");
      const srcChainId = 31337;
      const dstChainId = 31337;
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

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
            amount,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );

      // Relay tokens
      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
          ),
      )
        .to.be.revertedWithCustomError(router, "SourceChainIdShouldBeDifferentFromDestination")
        .withArgs(srcChainId, dstChainId);

      // Check recipient balance after transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);
    });

    it("should revert if requestId reconstruction fails", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

      // Mint tokens for user
      await dstToken.mint(userAddr, amount);

      // Approve Router to spend user's tokens
      await dstToken.connect(user).approve(await router.getAddress(), amount);

      // Pre-compute valid requestId
      const abiCoder = new AbiCoder();
      const requestId: string = keccak256(
        abiCoder.encode(
          ["address", "address", "address", "address", "uint256", "uint256", "uint256", "uint256"],
          [
            userAddr,
            recipientAddr,
            await dstToken.getAddress(), // Intentionally swap srcToken and dstToken here to cause mismatch
            await srcToken.getAddress(),
            amount,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );

      // Relay tokens
      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverAddr,
            requestId,
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
          ),
      ).to.be.revertedWithCustomError(router, "SwapRequestParametersMismatch()");

      // Check recipient balance after transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);
    });

    it("should return correct verification fee amount for a given swap amount", async () => {
      const feeBps = 250;
      await router.connect(owner).setVerificationFeeBps(feeBps);

      const amountToSwap = parseEther("100");
      const [feeAmount, amountOut] = await router.getVerificationFeeAmount(amountToSwap);

      // feeAmount = (amountToSwap * feeBps) / 10000
      const expectedFee = (amountToSwap * BigInt(feeBps)) / BigInt(10000);
      const expectedamountOut = amountToSwap - expectedFee;

      expect(feeAmount).to.equal(expectedFee);
      expect(amountOut).to.equal(expectedamountOut);
    });

    it("should revert swapRequestParametersToBytes if solver is zero address", async () => {
      const requestId = keccak256(toUtf8Bytes("test-request"));
      await expect(router.swapRequestParametersToBytes(requestId, ZeroAddress)).to.be.revertedWithCustomError(
        router,
        "ZeroAddress",
      );
    });

    it("should not allow double fulfillment", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

      // Mint tokens for user
      await dstToken.mint(solverAddr, amount);

      // Approve Router to spend user's tokens
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

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
            amount,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );
      const tx = await router
        .connect(solver)
        .relayTokens(
          solverRefundAddr,
          requestId,
          userAddr,
          recipientAddr,
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          srcChainId,
          nonce,
        );
      const receipt = await tx.wait();

      if (!receipt) {
        throw new Error("transaction has not been mined");
      }

      const routerInterface = Router__factory.createInterface();
      const [reqId, sourceChainId] = extractSingleLog(
        routerInterface,
        receipt,
        await router.getAddress(),
        routerInterface.getEvent("SwapRequestFulfilled"),
      );

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);

      // Try again with same requestId
      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            reqId,
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            sourceChainId,
            nonce,
          ),
      ).to.revertedWithCustomError(router, "AlreadyFulfilled()");

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);
    });

    it("relay receipt parameters should match event parameters", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      let destinationChainId = 31337;
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

      // Mint tokens for user
      await dstToken.mint(solverAddr, amount);

      // Approve Router to spend user's tokens
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

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
            amount,
            srcChainId,
            destinationChainId,
            nonce,
          ],
        ),
      );
      const tx = await router
        .connect(solver)
        .relayTokens(
          solverRefundAddr,
          requestId,
          userAddr,
          recipientAddr,
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          srcChainId,
          nonce,
        );
      const receipt = await tx.wait();

      if (!receipt) {
        throw new Error("transaction has not been mined");
      }

      const routerInterface = Router__factory.createInterface();
      const [reqId, sourceChainId, dstChainId] = extractSingleLog(
        routerInterface,
        receipt,
        await router.getAddress(),
        routerInterface.getEvent("SwapRequestFulfilled"),
      );

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);

      const swapRequestReceipt = await router.getSwapRequestReceipt(requestId);
      const [, , , srcTokenAddr, dstTokenAddr, fulfilled, sender, recipient, amountOut] = swapRequestReceipt;

      // Check receipt values
      expect(reqId).to.equal(requestId);
      expect(sourceChainId).to.equal(srcChainId);
      expect(dstChainId).to.equal(await router.getChainId());
      expect(srcTokenAddr).to.equal(await srcToken.getAddress());
      expect(dstTokenAddr).to.equal(await dstToken.getAddress());
      expect(fulfilled).to.be.true;
      expect(sender).to.equal(solverRefundAddr);
      expect(recipient).to.equal(recipientAddr);
      expect(amountOut).to.equal(amount);

      // Check recipient balance after transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(amount);
    });

    it("should return correct isFulfilled status", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      let destinationChainId = 31337;
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

      // Mint tokens for user
      await dstToken.mint(solverAddr, amount);

      // Approve Router to spend user's tokens
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

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
            amount,
            srcChainId,
            destinationChainId,
            nonce,
          ],
        ),
      );

      await router
        .connect(solver)
        .relayTokens(
          solverRefundAddr,
          requestId,
          userAddr,
          recipientAddr,
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          srcChainId,
          nonce,
        );

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.true;
      const fakeId = keccak256(toUtf8Bytes("non-existent"));
      expect((await router.getFulfilledTransfers()).includes(fakeId)).to.be.false;
    });

    it("should revert if trying to swap with zero amount", async () => {
      const amount = parseEther("0");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      await expect(
        router
          .connect(user)
          .requestCrossChainSwap(
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            amount,
            solverFee,
            DST_CHAIN_ID,
            recipientAddr,
          ),
      ).to.be.revertedWithCustomError(router, "ZeroAmount()");
    });

    it("should revert if trying to request a swap with zero recipient address", async () => {
      const amount = parseEther("1");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      recipientAddr = ZeroAddress;

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      await expect(
        router
          .connect(user)
          .requestCrossChainSwap(
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            amount,
            solverFee,
            DST_CHAIN_ID,
            recipientAddr,
          ),
      ).to.be.revertedWithCustomError(router, "ZeroAddress()");
    });

    it("should revert if destination chain id is not supported", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      // Do not permit the newChainId
      const newChainId = 1234;

      await expect(
        router
          .connect(user)
          .requestCrossChainSwap(
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            amount,
            solverFee,
            newChainId,
            recipientAddr,
          ),
      )
        .to.be.revertedWithCustomError(router, "DestinationChainIdNotSupported")
        .withArgs(newChainId);
    });

    it("should revert if token mapping does not exist", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      const newChainId = 1234;

      await router.connect(owner).permitDestinationChainId(newChainId);

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      await expect(
        router
          .connect(user)
          .requestCrossChainSwap(
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            amount,
            solverFee,
            newChainId,
            recipientAddr,
          ),
      ).to.be.revertedWithCustomError(router, "TokenNotSupported()");
    });

    it("should revert if user tries to update solver fee for a fulfilled request", async () => {
      const amount = parseEther("5");
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

      // Fulfill the request
      const [, messageAsG1Bytes] = await router.swapRequestParametersToBytes(requestId, solver.address);
      // Remove "0x" prefix if present
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
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

      await router.connect(owner).rebalanceSolver(solver.address, requestId, sigBytes);

      // Try to update fee after fulfillment
      const newFee = parseEther("2");
      await expect(router.connect(user).updateSolverFeesIfUnfulfilled(requestId, newFee)).to.be.revertedWithCustomError(
        router,
        "AlreadyFulfilled()",
      );
    });

    it("should revert if non-owner tries to permit destination chain", async () => {
      await expect(router.connect(user).permitDestinationChainId(12345)).to.be.revertedWithCustomError(
        router,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should revert if non-owner tries to set token mapping", async () => {
      await expect(
        router.connect(user).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress()),
      ).to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    });

    it("should revert if trying to withdraw verification fee for token with zero balance", async () => {
      await expect(
        router.connect(owner).withdrawVerificationFee(await dstToken.getAddress(), ownerAddr),
      ).to.be.revertedWithCustomError(router, "ZeroAmount()");
    });

    it("should revert if relayTokens is called with zero amount", async () => {
      const amount = 0;
      const srcChainId = 1;
      let destinationChainId = 31337;
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

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
            amount,
            srcChainId,
            destinationChainId,
            nonce,
          ],
        ),
      );

      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
          ),
      ).to.be.revertedWithCustomError(router, "ZeroAmount()");

      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);
    });

    it("should revert if relayTokens is called with zero address as recipient", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 1;
      recipientAddr = ZeroAddress;

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

      // Mint tokens for user
      await dstToken.mint(solverAddr, amount);

      // Approve Router to spend user's tokens
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

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
            amount,
            srcChainId,
            dstChainId,
            nonce,
          ],
        ),
      );

      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            recipientAddr,
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
          ),
      ).to.be.revertedWithCustomError(router, "InvalidTokenOrRecipient()");

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);
    });

    it("should revert if trying to approve more tokens than balance", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount; // Not enough to cover solverFee

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint + solverFee);

      await expect(
        router
          .connect(user)
          .requestCrossChainSwap(
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            amount,
            solverFee,
            DST_CHAIN_ID,
            recipientAddr,
          ),
      ).to.be.reverted;
    });

    it("should revert if rebalanceSolver is called with invalid signature", async () => {
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

      // Use random bytes as invalid signature
      const invalidSig = AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [123, 456]);

      await expect(
        router.connect(owner).rebalanceSolver(solver.address, requestId, invalidSig),
      ).to.be.revertedWithCustomError(router, "BLSSignatureVerificationFailed()");
    });
  });

  describe("BLS Validator Management", () => {
    it("should revert if setSwapRequestBlsValidator is called with zero address", async () => {
      const invalidAddress = ZeroAddress;
      const currentNonce = Number(await router.currentNonce()) + 1;
      const sigBytes = await generateSignatureForBlsValidatorUpdate(
        router,
        "change-swap-request-bls-validator",
        invalidAddress,
        currentNonce,
      );
      await expect(
        router.connect(owner).setSwapRequestBlsValidator(invalidAddress, sigBytes),
      ).to.be.revertedWithCustomError(router, "ZeroAddress()");

      expect(await router.swapRequestBlsValidator()).to.not.equal(ZeroAddress);
    });

    it("should revert if BLS signature verification fails", async () => {
      const validAddress = await owner.getAddress();
      const invalidSignature = AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [123, 456]);

      await expect(
        router.connect(owner).setSwapRequestBlsValidator(validAddress, invalidSignature),
      ).to.be.revertedWithCustomError(router, "BLSSignatureVerificationFailed()");
    });

    it("should update the swapRequestBlsValidator if called with valid parameters", async () => {
      const validAddress = await owner.getAddress();
      const currentNonce = Number(await router.currentNonce()) + 1;
      const sigBytes = await generateSignatureForBlsValidatorUpdate(
        router,
        "change-swap-request-bls-validator",
        validAddress,
        currentNonce,
      );

      await expect(router.connect(owner).setSwapRequestBlsValidator(validAddress, sigBytes))
        .to.emit(router, "BLSValidatorUpdated")
        .withArgs(validAddress);

      const updatedValidator = await router.swapRequestBlsValidator();
      expect(updatedValidator).to.equal(validAddress);
    });

    it("should update the upgradeBlsValidator if called with valid parameters", async () => {
      const validAddress = await owner.getAddress();
      const currentNonce = Number(await router.currentNonce()) + 1;
      const sigBytes = await generateSignatureForBlsValidatorUpdate(
        router,
        "change-contract-upgrade-bls-validator",
        validAddress,
        currentNonce,
      );

      await expect(router.connect(owner).setContractUpgradeBlsValidator(validAddress, sigBytes))
        .to.emit(router, "ContractUpgradeBLSValidatorUpdated")
        .withArgs(validAddress);

      const updatedValidator = await router.contractUpgradeBlsValidator();
      expect(updatedValidator).to.equal(validAddress);
      expect(await router.getContractUpgradeBlsValidator()).to.equal(validAddress);
    });

    it("should fail to update the upgradeBlsValidator if called with invalid signature", async () => {
      const validAddress = await owner.getAddress();
      // Use an invalid signature
      const invalidSigBytes = AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [123, 456]);

      await expect(
        router.connect(owner).setContractUpgradeBlsValidator(validAddress, invalidSigBytes),
      ).to.be.revertedWithCustomError(router, "BLSSignatureVerificationFailed()");
    });

    it("should revert if setContractUpgradeBlsValidator is called with zero address", async () => {
      const invalidAddress = ZeroAddress;
      const currentNonce = Number(await router.currentNonce()) + 1;
      const sigBytes = await generateSignatureForBlsValidatorUpdate(
        router,
        "change-contract-upgrade-bls-validator",
        invalidAddress,
        currentNonce,
      );
      await expect(
        router.connect(owner).setContractUpgradeBlsValidator(invalidAddress, sigBytes),
      ).to.be.revertedWithCustomError(router, "ZeroAddress()");
    });

    it("should not revert if non-owner tries to call setSwapRequestBlsValidator", async () => {
      const validAddress = await owner.getAddress();
      const currentNonce = Number(await router.currentNonce()) + 1;
      const sigBytes = await generateSignatureForBlsValidatorUpdate(
        router,
        "change-swap-request-bls-validator",
        validAddress,
        currentNonce,
      );

      await expect(router.connect(user).setSwapRequestBlsValidator(validAddress, sigBytes)).to.not.be.reverted;
    });

    it("should not revert if non-owner tries to call setContractUpgradeBlsValidator", async () => {
      const validAddress = await owner.getAddress();
      const currentNonce = Number(await router.currentNonce()) + 1;
      const sigBytes = await generateSignatureForBlsValidatorUpdate(
        router,
        "change-contract-upgrade-bls-validator",
        validAddress,
        currentNonce,
      );

      await expect(router.connect(user).setContractUpgradeBlsValidator(validAddress, sigBytes)).to.not.be.reverted;
    });
  });

  describe("Minimum Contract Upgrade Delay Management", () => {
    it("should update minimumContractUpgradeDelay and emit event if delay is greater than 2 days", async () => {
      const newDelay = 3 * 24 * 60 * 60; // 3 days in seconds

      const currentNonce = Number(await router.currentNonce()) + 1;
      const [, messageAsG1Bytes] = await router.minimumContractUpgradeDelayParamsToBytes(
        "change-upgrade-delay",
        newDelay,
        currentNonce,
      );
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
      const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
      const sigPoint = bn254.signShortSignature(M, privKeyBytes);
      const sigPointToAffine = sigPoint.toAffine();
      const sigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [sigPointToAffine.x, sigPointToAffine.y],
      );

      // anyone can call this function, not just owner
      const tx = await router.connect(solver).setMinimumContractUpgradeDelay(newDelay, sigBytes);
      await expect(tx).to.emit(router, "MinimumContractUpgradeDelayUpdated").withArgs(newDelay);

      expect(await router.minimumContractUpgradeDelay()).to.equal(newDelay);
    });

    it("should revert if minimumContractUpgradeDelay is less than 2 days", async () => {
      const invalidDelay = 1 * 24 * 60 * 60; // 1 day in seconds

      const currentNonce = Number(await router.currentNonce()) + 1;
      const [, messageAsG1Bytes] = await router.minimumContractUpgradeDelayParamsToBytes(
        "change-upgrade-delay",
        invalidDelay,
        currentNonce,
      );
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
      const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
      const sigPoint = bn254.signShortSignature(M, privKeyBytes);
      const sigPointToAffine = sigPoint.toAffine();
      const sigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [sigPointToAffine.x, sigPointToAffine.y],
      );

      await expect(router.setMinimumContractUpgradeDelay(invalidDelay, sigBytes)).to.be.revertedWithCustomError(
        router,
        "UpgradeDelayTooShort",
      );

      const zeroDelay = 0;
      const [, zeroMessageAsG1Bytes] = await router.minimumContractUpgradeDelayParamsToBytes(
        "change-upgrade-delay",
        zeroDelay,
        currentNonce + 1,
      );
      const zeroMessageHex = zeroMessageAsG1Bytes.startsWith("0x")
        ? zeroMessageAsG1Bytes.slice(2)
        : zeroMessageAsG1Bytes;
      const zeroM = bn254.G1.ProjectivePoint.fromHex(zeroMessageHex);
      const zeroSigPoint = bn254.signShortSignature(zeroM, privKeyBytes);
      const zeroSigPointToAffine = zeroSigPoint.toAffine();
      const zeroSigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [zeroSigPointToAffine.x, zeroSigPointToAffine.y],
      );

      await expect(router.setMinimumContractUpgradeDelay(zeroDelay, zeroSigBytes)).to.be.revertedWithCustomError(
        router,
        "UpgradeDelayTooShort",
      );
    });

    it("should revert if setMinimumContractUpgradeDelay is called with invalid signature", async () => {
      const newDelay = 3 * 24 * 60 * 60; // 3 days in seconds
      const invalidSigBytes = AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [123, 456]);

      await expect(router.setMinimumContractUpgradeDelay(newDelay, invalidSigBytes)).to.be.revertedWithCustomError(
        router,
        "BLSSignatureVerificationFailed",
      );
    });
  });

  describe("ScheduledUpgradeable", () => {
    it("should initialize ScheduledUpgradeable with valid parameters", async () => {
      const validValidator = await upgradeBn254SigScheme.getAddress();

      // Deploy a Router (or a mock child contract) with valid params
      const routerImpl = await ethers.getContractFactory("Router", owner);
      const implementation = await routerImpl.deploy();
      await implementation.waitForDeployment();

      const proxyFactory = await ethers.getContractFactory("UUPSProxy", owner);
      const proxy = await proxyFactory.deploy(
        await implementation.getAddress(),
        routerImpl.interface.encodeFunctionData("initialize", [
          ownerAddr,
          await swapBn254SigScheme.getAddress(),
          validValidator,
          VERIFICATION_FEE_BPS,
        ]),
      );
      await proxy.waitForDeployment();

      const router: any = routerImpl.attach(await proxy.getAddress());
      expect(await router.contractUpgradeBlsValidator()).to.equal(validValidator);
      expect(await router.minimumContractUpgradeDelay()).to.equal(172800); // 2 days in seconds
    });

    it("should revert if _contractUpgradeBlsValidator is zero address", async () => {
      const routerImpl = await ethers.getContractFactory("Router", owner);
      const implementation = await routerImpl.deploy();
      await implementation.waitForDeployment();

      const proxyFactory = await ethers.getContractFactory("UUPSProxy", owner);

      await expect(
        proxyFactory.deploy(
          await implementation.getAddress(),
          routerImpl.interface.encodeFunctionData("initialize", [
            ownerAddr,
            await swapBn254SigScheme.getAddress(),
            ZeroAddress, // zero address for contractUpgradeBlsValidator
            VERIFICATION_FEE_BPS,
          ]),
        ),
      ).to.be.revertedWithCustomError(implementation, "ZeroAddress");
    });

    it("should revert if scheduleUpgrade is called with zero address not having getVersion() function", async () => {
      const upgradeCalldata = "0x";
      const upgradeTime = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60; // 3 days from now
      const signature = "0x1234";

      await expect(router.scheduleUpgrade(ZeroAddress, upgradeCalldata, upgradeTime, signature)).to.be.reverted;
    });

    it("should revert if scheduleUpgrade is called with same implementation address", async () => {
      const upgradeCalldata = "0x";
      const upgradeTime = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
      const signature = "0x1234";
      const currentImpl = await router.getAddress();

      await expect(
        router.scheduleUpgrade(currentImpl, upgradeCalldata, upgradeTime, signature),
      ).to.be.revertedWithCustomError(router, "SameVersionUpgradeNotAllowed");
    });

    it("should revert if upgradeTime is less than minimumContractUpgradeDelay", async () => {
      const upgradeCalldata = "0x";
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const upgradeTime = Math.floor(Date.now() / 1000) + 1; // Too soon
      const signature = "0x1234";

      await expect(
        router.scheduleUpgrade(newImplAddress, upgradeCalldata, upgradeTime, signature),
      ).to.be.revertedWithCustomError(router, "UpgradeTimeMustRespectDelay");
    });

    it("should revert if BLS signature verification fails", async () => {
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const upgradeCalldata = "0x";
      // Ensure upgradeTime is at least block.timestamp + minimumContractUpgradeDelay
      const minimumDelay = await router.minimumContractUpgradeDelay();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = Number(latestBlock!.timestamp) + Number(minimumDelay) + 1;
      const invalidSignature = AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [123, 456]);

      await expect(
        router.scheduleUpgrade(newImplAddress, upgradeCalldata, upgradeTime, invalidSignature),
      ).to.be.revertedWithCustomError(router, "BLSSignatureVerificationFailed");
    });
  });

  describe("Admin Functions", () => {
    it("should revert blockDestinationChainId if called by non-admin", async () => {
      const chainId = 555;
      await router.connect(owner).permitDestinationChainId(chainId);

      await expect(router.connect(user).blockDestinationChainId(chainId)).to.be.revertedWithCustomError(
        router,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should block a permitted destination chain id and emit event", async () => {
      const chainId = 555;
      await router.connect(owner).permitDestinationChainId(chainId);

      await expect(router.connect(owner).blockDestinationChainId(chainId))
        .to.emit(router, "DestinationChainIdBlocked")
        .withArgs(chainId);
      expect(await router.getAllowedDstChainId(chainId)).to.be.false;
    });

    it("should revert setVerificationFeeBps if called by non-admin", async () => {
      const newFeeBps = 100;
      await expect(router.connect(user).setVerificationFeeBps(newFeeBps)).to.be.revertedWithCustomError(
        router,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should revert if setVerificationFeeBps is called with value above MAX_FEE_BPS", async () => {
      const maxFeeBps = await router.MAX_FEE_BPS();
      await expect(router.connect(owner).setVerificationFeeBps(Number(maxFeeBps) + 1)).to.be.revertedWithCustomError(
        router,
        "FeeBpsExceedsThreshold",
      );
    });

    it("should revert if setVerificationFeeBps is called with zero", async () => {
      await expect(router.connect(owner).setVerificationFeeBps(0)).to.be.revertedWithCustomError(
        router,
        "InvalidFeeBps",
      );
    });

    it("should update verificationFeeBps and emit event if called by admin with valid value", async () => {
      const newFeeBps = 250;
      await expect(router.connect(owner).setVerificationFeeBps(newFeeBps))
        .to.emit(router, "VerificationFeeBpsUpdated")
        .withArgs(newFeeBps);

      expect(await router.getVerificationFeeBps()).to.equal(newFeeBps);
    });
  });

  describe("BN254SignatureScheme", () => {
    it("should return the correct public key bytes from BN254SignatureScheme", async () => {
      // Get marshaled public key bytes from the contract
      const pubKeyBytesFromContract = await swapBn254SigScheme.getPublicKeyBytes();
      // unmarshal to a G2 point using noble-bn254
      // Remove "0x" prefix if present
      const pubKeyHex = pubKeyBytesFromContract.startsWith("0x")
        ? pubKeyBytesFromContract.slice(2)
        : pubKeyBytesFromContract;
      const pubKeyPointFromContract = bn254.G2.ProjectivePoint.fromHex(pubKeyHex).toAffine();

      // Get public key directly from the private key (G2 point)
      const pk = bn254.getPublicKeyForShortSignatures(privKeyBytes);
      const pubKeyPoint = bn254.G2.ProjectivePoint.fromHex(pk).toAffine();

      // Compare the points
      expect(pubKeyPointFromContract.x.c0).to.equal(pubKeyPoint.x.c0);
      expect(pubKeyPointFromContract.y.c0).to.equal(pubKeyPoint.y.c0);

      expect(pubKeyPointFromContract.x.c1).to.equal(pubKeyPoint.x.c1);
      expect(pubKeyPointFromContract.y.c1).to.equal(pubKeyPoint.y.c1);
    });
  });

  describe("Swap Request Cancellation and Refund", () => {
    let amount: bigint;
    let fee: bigint;
    let amountToMint: bigint;
    let requestId: string;

    beforeEach(async () => {
      amount = parseEther("10");
      fee = parseEther("1");
      amountToMint = amount + fee;

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      const tx = await router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          amount,
          fee,
          DST_CHAIN_ID,
          recipientAddr,
        );
      const receipt = await tx.wait();
      const routerInterface = Router__factory.createInterface();
      [requestId] = extractSingleLog(
        routerInterface,
        receipt!,
        await router.getAddress(),
        routerInterface.getEvent("SwapRequested"),
      );
    });

    it("should stage a swap request cancellation and emit event", async () => {
      expect(await router.currentSwapRequestNonce()).to.equal(1);
      expect(await router.swapRequestCancellationInitiatedAt(requestId)).to.equal(0);

      const blockTimestamp = (await ethers.provider.getBlock("latest"))!.timestamp;
      await expect(router.connect(user).stageSwapRequestCancellation(requestId))
        .to.emit(router, "SwapRequestCancellationStaged")
        .withArgs(requestId, userAddr, blockTimestamp + 1);

      // Should revert if called again
      await expect(router.connect(user).stageSwapRequestCancellation(requestId)).to.be.revertedWithCustomError(
        router,
        "SwapRequestCancellationAlreadyStaged",
      );

      expect(await router.swapRequestCancellationInitiatedAt(requestId)).to.be.greaterThan(0);
    });

    it("should revert stageSwapRequestCancellation if called by non-request sender", async () => {
      await expect(router.connect(solver).stageSwapRequestCancellation(requestId)).to.be.revertedWithCustomError(
        router,
        "UnauthorisedCaller",
      );
    });

    it("should revert stageSwapRequestCancellation if already fulfilled", async () => {
      // Fulfill the request
      const [, messageAsG1Bytes] = await router.swapRequestParametersToBytes(requestId, solver.address);
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
      const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
      const sigPoint = bn254.signShortSignature(M, privKeyBytes);
      const sigPointToAffine = sigPoint.toAffine();
      const sigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [sigPointToAffine.x, sigPointToAffine.y],
      );
      await router.connect(owner).rebalanceSolver(solver.address, requestId, sigBytes);

      await expect(router.connect(user).stageSwapRequestCancellation(requestId)).to.be.revertedWithCustomError(
        router,
        "AlreadyFulfilled",
      );
    });

    it("should revert cancelSwapRequestAndRefund if not staged", async () => {
      await expect(
        router.connect(user).cancelSwapRequestAndRefund(requestId, recipientAddr),
      ).to.be.revertedWithCustomError(router, "SwapRequestCancellationNotStaged");
    });

    it("should revert cancelSwapRequestAndRefund if called by non-request sender", async () => {
      await router.connect(user).stageSwapRequestCancellation(requestId);
      await ethers.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]); // 2 days
      await ethers.provider.send("evm_mine", []);
      await expect(
        router.connect(solver).cancelSwapRequestAndRefund(requestId, recipientAddr),
      ).to.be.revertedWithCustomError(router, "UnauthorisedCaller");
    });

    it("should revert cancelSwapRequestAndRefund if cancellation window not passed", async () => {
      await router.connect(user).stageSwapRequestCancellation(requestId);
      await expect(
        router.connect(user).cancelSwapRequestAndRefund(requestId, recipientAddr),
      ).to.be.revertedWithCustomError(router, "SwapRequestCancellationWindowNotPassed");
    });

    it("should revert cancelSwapRequestAndRefund if recipient is zero address", async () => {
      await router.connect(user).stageSwapRequestCancellation(requestId);
      await ethers.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]); // 2 days
      await ethers.provider.send("evm_mine", []);
      await expect(
        router.connect(user).cancelSwapRequestAndRefund(requestId, ZeroAddress),
      ).to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("should revert cancelSwapRequestAndRefund if insufficient verification fee balance", async () => {
      // Withdraw verification fee so balance is zero
      await router.connect(owner).withdrawVerificationFee(await srcToken.getAddress(), ownerAddr);
      await router.connect(user).stageSwapRequestCancellation(requestId);
      await ethers.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]); // 2 days
      await ethers.provider.send("evm_mine", []);
      await expect(
        router.connect(user).cancelSwapRequestAndRefund(requestId, recipientAddr),
      ).to.be.revertedWithCustomError(router, "InsufficientVerificationFeeBalance");
    });

    it("should cancel a staged swap request and refund the user, emitting event", async () => {
      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      await router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          amount,
          fee,
          DST_CHAIN_ID,
          recipientAddr,
        );

      await router.connect(user).stageSwapRequestCancellation(requestId);
      await ethers.provider.send("evm_increaseTime", [2 * 24 * 60 * 60]); // 2 days
      await ethers.provider.send("evm_mine", []);

      const beforeBalance = await srcToken.balanceOf(recipientAddr);

      const params = await router.getSwapRequestParameters(requestId);
      const totalRefund = amount + params.solverFee;

      await expect(router.connect(user).cancelSwapRequestAndRefund(requestId, recipientAddr))
        .to.emit(router, "SwapRequestRefundClaimed")
        .withArgs(requestId, userAddr, recipientAddr, totalRefund);

      const afterBalance = await srcToken.balanceOf(recipientAddr);
      expect(afterBalance - beforeBalance).to.equal(totalRefund);

      // Should mark as executed and cancelled
      const updatedParams = await router.getSwapRequestParameters(requestId);
      expect(updatedParams.executed).to.be.true;
      expect((await router.getCancelledSwapRequests()).includes(requestId)).to.be.true;
    });

    it("should revert if trying to cancel already fulfilled request", async () => {
      // Fulfill the request
      const [, messageAsG1Bytes] = await router.swapRequestParametersToBytes(requestId, solver.address);
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
      const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
      const sigPoint = bn254.signShortSignature(M, privKeyBytes);
      const sigPointToAffine = sigPoint.toAffine();
      const sigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [sigPointToAffine.x, sigPointToAffine.y],
      );
      await router.connect(owner).rebalanceSolver(solver.address, requestId, sigBytes);

      await expect(
        router.connect(user).cancelSwapRequestAndRefund(requestId, recipientAddr),
      ).to.be.revertedWithCustomError(router, "AlreadyFulfilled");
    });

    it("should update the swap request cancellation window and emit event", async () => {
      const newWindow = 3 * 24 * 60 * 60; // 3 days
      const currentNonce = Number(await router.currentNonce()) + 1;
      const [, messageAsG1Bytes] = await router.minimumContractUpgradeDelayParamsToBytes(
        "change-cancellation-window",
        newWindow,
        currentNonce,
      );
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
      const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
      const sigPoint = bn254.signShortSignature(M, privKeyBytes);
      const sigPointToAffine = sigPoint.toAffine();
      const sigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [sigPointToAffine.x, sigPointToAffine.y],
      );

      await expect(router.setCancellationWindow(newWindow, sigBytes))
        .to.emit(router, "SwapRequestCancellationWindowUpdated")
        .withArgs(newWindow);

      expect(await router.swapRequestCancellationWindow()).to.equal(newWindow);
    });

    it("should revert setCancellationWindow if new window is less than 1 day", async () => {
      const newWindow = 12 * 60 * 60; // 12 hours
      const currentNonce = Number(await router.currentNonce()) + 1;
      const [, messageAsG1Bytes] = await router.minimumContractUpgradeDelayParamsToBytes(
        "change-cancellation-window",
        newWindow,
        currentNonce,
      );
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
      const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
      const sigPoint = bn254.signShortSignature(M, privKeyBytes);
      const sigPointToAffine = sigPoint.toAffine();
      const sigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [sigPointToAffine.x, sigPointToAffine.y],
      );

      await expect(router.setCancellationWindow(newWindow, sigBytes)).to.be.revertedWithCustomError(
        router,
        "SwapRequestCancellationWindowTooShort",
      );
    });

    it("should revert setCancellationWindow if signature is invalid", async () => {
      const newWindow = 2 * 24 * 60 * 60;
      const invalidSig = AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [123, 456]);
      await expect(router.setCancellationWindow(newWindow, invalidSig)).to.be.revertedWithCustomError(
        router,
        "BLSSignatureVerificationFailed",
      );
    });
  });
});
