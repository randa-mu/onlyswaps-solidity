import {
  Router,
  Router__factory,
  MockRouterV2__factory,
  ERC20Token,
  ERC20Token__factory,
  BLSBN254SignatureScheme,
  BLSBN254SignatureScheme__factory,
  UUPSProxy__factory,
  BLS__factory,
} from "../../typechain-types";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect, use } from "chai";
import {
  AbiCoder,
  parseEther,
  TransactionReceipt,
  Interface,
  EventFragment,
  Result,
  keccak256,
  toUtf8Bytes,
  ZeroAddress,
  hexlify,
} from "ethers";
import { ethers } from "hardhat";
import { parse } from "path";

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
    await router.connect(owner).permitDestinationChainId(DST_CHAIN_ID);
    await router.connect(owner).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());
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

  it("should remove the token mapping for a specific destination chain", async () => {
    // Ensure the token mapping exists before removal
    expect(await router.isDstTokenMapped(await srcToken.getAddress(), DST_CHAIN_ID, await dstToken.getAddress())).to.be
      .true;

    // Remove the token mapping
    await router
      .connect(owner)
      .removeTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());

    // Check that the token mapping has been removed
    expect(await router.isDstTokenMapped(await srcToken.getAddress(), DST_CHAIN_ID, await dstToken.getAddress())).to.be
      .false;
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
    expect(await router.isDstTokenMapped(await srcToken.getAddress(), DST_CHAIN_ID, await secondDstToken.getAddress()))
      .to.be.true;
  });

  it("should revert if dst chain id is not permitted", async () => {
    const secondDstToken = await new ERC20Token__factory(owner).deploy("RUSD2", "RUSD2", 18);
    const dstChainId = 1000; // Not permitted in beforeEach

    // First destination token already mapped in beforeEach
    await expect(
      router.connect(owner).setTokenMapping(dstChainId, await dstToken.getAddress(), await srcToken.getAddress()),
    ).to.be.revertedWithCustomError(router, "DestinationChainIdNotSupported");

    expect(await router.isDstTokenMapped(await srcToken.getAddress(), dstChainId, await secondDstToken.getAddress())).to
      .be.false;
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

  it("should initiate a swap request and emit message", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    await expect(
      router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          fee,
          DST_CHAIN_ID,
          recipientAddr,
        ),
    ).to.emit(router, "SwapRequested");
  });

  it("should revert if fee is too low", async () => {
    const amount = parseEther("10");
    const fee = parseEther("0"); // Set fee lower than the required swap fee
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    await expect(
      router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          fee,
          DST_CHAIN_ID,
          recipientAddr,
        ),
    ).to.be.revertedWithCustomError(router, "FeeTooLow");
  });

  it("should update the total swap request fee for unfulfilled request", async () => {
    const amount = parseEther("5");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    const tx = await router
      .connect(user)
      .requestCrossChainSwap(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        fee,
        DST_CHAIN_ID,
        recipient.address,
      );

    let receipt = await tx.wait();
    if (!receipt) {
      throw new Error("transaction has not been mined");
    }

    const routerInterface = Router__factory.createInterface();
    const [requestId, message] = extractSingleLog(
      routerInterface,
      receipt,
      await router.getAddress(),
      routerInterface.getEvent("SwapRequested"),
    );

    const newFee = parseEther("1.5");
    await srcToken.mint(user.address, newFee - fee);
    await srcToken.connect(user).approve(await router.getAddress(), newFee - fee);

    expect(await srcToken.balanceOf(userAddr)).to.equal(newFee - fee);

    // Check: only sender can update fee
    await expect(router.connect(solver).updateSolverFeesIfUnfulfilled(requestId, newFee)).to.be.revertedWithCustomError(
      router,
      "UnauthorisedCaller",
    );

    // Check: newFee must be greater than current solverFee
    await expect(router.connect(user).updateSolverFeesIfUnfulfilled(requestId, fee)).to.be.revertedWithCustomError(
      router,
      "NewFeeTooLow",
    );

    await expect(router.connect(user).updateSolverFeesIfUnfulfilled(requestId, newFee)).to.emit(
      router,
      "SwapRequestSolverFeeUpdated",
    );

    expect(await srcToken.balanceOf(userAddr)).to.equal(0);

    const swapRequestParams = await router.getSwapRequestParameters(requestId);
    expect(swapRequestParams.solverFee).to.equal(newFee);
  });

  it("should block non-owner from withdrawing fees and revert with AccessControlUnauthorizedAccount for caller address and ADMIN_ROLE", async () => {
    await expect(router.connect(user).withdrawVerificationFee(await srcToken.getAddress(), user.address)).to.be
      .reverted;
  });

  it("should allow owner to withdraw verification fees", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    const tx = await router
      .connect(user)
      .requestCrossChainSwap(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        fee,
        DST_CHAIN_ID,
        recipient.address,
      );

    let receipt = await tx.wait();
    if (!receipt) {
      throw new Error("transaction has not been mined");
    }

    const routerInterface = Router__factory.createInterface();
    const [requestId, message] = extractSingleLog(
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
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    const tx = await router
      .connect(user)
      .requestCrossChainSwap(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        fee,
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
    const receipt = await router.swapRequestReceipts(requestId);
    expect(receipt.fulfilled).to.be.true;
    expect(receipt.amountOut).to.equal(amount);
    expect(receipt.solver).to.equal(solverRefundAddr);

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
      router
        .connect(solver)
        .relayTokens(
          ZeroAddress,
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
    const receipt = await router.swapRequestReceipts(requestId);
    expect(receipt.fulfilled).to.be.false;
    expect(receipt.amountOut).to.equal(0n);
    expect(receipt.solver).to.equal(ZeroAddress);

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
          userAddr,
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

    expect((await router.getFulfilledTransfers()).length).to.be.equal(1);
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
    // Check receipt values
    expect(swapRequestReceipt[0]).to.equal(requestId);
    expect(swapRequestReceipt[1]).to.equal(srcChainId);
    expect(swapRequestReceipt[2]).to.equal(await router.getChainID());
    expect(swapRequestReceipt[3]).to.equal(await dstToken.getAddress());
    expect(swapRequestReceipt[4]).to.be.true;
    expect(swapRequestReceipt[5]).to.equal(userAddr);
    expect(swapRequestReceipt[6]).to.equal(recipientAddr);
    expect(swapRequestReceipt[7]).to.equal(amount);

    // Check transaction receipt values compared to emitted event
    expect(reqId).to.equal(swapRequestReceipt[0]);
    expect(sourceChainId).to.equal(swapRequestReceipt[1]);
    expect(dstChainId).to.equal(swapRequestReceipt[2]);

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
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    await expect(
      router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          fee,
          DST_CHAIN_ID,
          recipientAddr,
        ),
    ).to.be.revertedWithCustomError(router, "ZeroAmount()");
  });

  it("should revert if trying to request a swap with zero recipient address", async () => {
    const amount = parseEther("1");
    const fee = parseEther("1");
    const amountToMint = amount + fee;
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
          fee,
          DST_CHAIN_ID,
          recipientAddr,
        ),
    ).to.be.revertedWithCustomError(router, "ZeroAddress()");
  });

  it("should revert if destination chain id is not supported", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    // Do not permit the newChainId
    const newChainId = 1234;

    await expect(
      router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          fee,
          newChainId,
          recipientAddr,
        ),
    )
      .to.be.revertedWithCustomError(router, "DestinationChainIdNotSupported")
      .withArgs(newChainId);
  });

  it("should revert if token mapping does not exist", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount + fee;
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
          fee,
          newChainId,
          recipientAddr,
        ),
    ).to.be.revertedWithCustomError(router, "TokenNotSupported()");
  });

  it("should revert if user tries to update solver fee for a fulfilled request", async () => {
    const amount = parseEther("5");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    const tx = await router
      .connect(user)
      .requestCrossChainSwap(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        fee,
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
    const fee = parseEther("1");
    const amountToMint = amount; // Not enough for fee

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint + fee);

    await expect(
      router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          fee,
          DST_CHAIN_ID,
          recipientAddr,
        ),
    ).to.be.reverted;
  });

  it("should revert if rebalanceSolver is called with invalid signature", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    const tx = await router
      .connect(user)
      .requestCrossChainSwap(
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        fee,
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

  it("should return correct contract version", async () => {
    const version = await router.getVersion();
    expect(version).to.equal("1.0.0");
  });

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

    const tx = await router.setMinimumContractUpgradeDelay(newDelay, sigBytes);
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
    const zeroMessageHex = zeroMessageAsG1Bytes.startsWith("0x") ? zeroMessageAsG1Bytes.slice(2) : zeroMessageAsG1Bytes;
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

  it("should revert removeTokenMapping if called by non-admin", async () => {
    const dstChainId = 137;

    // Try to remove mapping as a non-admin
    await expect(router.connect(user).removeTokenMapping(dstChainId, dstToken, srcToken)).to.be.revertedWithCustomError(
      router,
      "AccessControlUnauthorizedAccount",
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
    await expect(router.connect(owner).setVerificationFeeBps(0)).to.be.revertedWithCustomError(router, "InvalidFeeBps");
  });

  it("should update verificationFeeBps and emit event if called by admin with valid value", async () => {
    const newFeeBps = 250;
    await expect(router.connect(owner).setVerificationFeeBps(newFeeBps))
      .to.emit(router, "VerificationFeeBpsUpdated")
      .withArgs(newFeeBps);

    expect(await router.getVerificationFeeBps()).to.equal(newFeeBps);
  });

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

// Returns the first instance of an event log from a transaction receipt that matches the address provided
function extractSingleLog<T extends Interface, E extends EventFragment>(
  iface: T,
  receipt: TransactionReceipt,
  contractAddress: string,
  event: E,
): Result {
  const events = extractLogs(iface, receipt, contractAddress, event);
  if (events.length === 0) {
    throw Error(`contract at ${contractAddress} didn't emit the ${event.name} event`);
  }
  return events[0];
}

// Returns an array of all event logs from a transaction receipt that match the address provided
function extractLogs<T extends Interface, E extends EventFragment>(
  iface: T,
  receipt: TransactionReceipt,
  contractAddress: string,
  event: E,
): Array<Result> {
  return receipt.logs
    .filter((log) => log.address.toLowerCase() === contractAddress.toLowerCase())
    .map((log) => iface.decodeEventLog(event, log.data, log.topics));
}
