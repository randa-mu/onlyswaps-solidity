import {
  Router,
  Router__factory,
  ERC20Token,
  ERC20Token__factory,
  BN254SignatureScheme,
  BN254SignatureScheme__factory,
  UUPSProxy__factory,
} from "../../typechain-types";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import {
  AbiCoder,
  parseEther,
  TransactionReceipt,
  Interface,
  EventFragment,
  Result,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { ethers } from "hardhat";

const DST_CHAIN_ID = 137;

const VERIFICATION_FEE_BPS = 500;

describe("Router", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let solver: SignerWithAddress;
  let recipient: SignerWithAddress;

  let router: Router;
  let srcToken: ERC20Token;
  let dstToken: ERC20Token;
  let bn254SigScheme: BN254SignatureScheme;

  let privKeyBytes: Uint8Array;
  let ownerAddr: string, solverAddr: string, userAddr: string, recipientAddr: string;

  beforeEach(async () => {
    [owner, user, solver, recipient] = await ethers.getSigners();

    ownerAddr = await owner.getAddress();
    userAddr = await user.getAddress();
    recipientAddr = await recipient.getAddress();
    solverAddr = await solver.getAddress();

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
    bn254SigScheme = await new BN254SignatureScheme__factory(owner).deploy([x.c1, x.c0], [y.c1, y.c0]);

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
        await bn254SigScheme.getAddress(),
        await bn254SigScheme.getAddress(),
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

  it("should initiate a swap request and emit message", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    await expect(
      router.connect(user).requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipientAddr),
    ).to.emit(router, "SwapRequested");
  });

  it("should revert if fee is too low", async () => {
    const amount = parseEther("10");
    const fee = parseEther("0"); // Set fee lower than the required swap fee
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    await expect(
      router.connect(user).requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipientAddr),
    ).to.be.revertedWithCustomError(router, "FeeTooLow()");
  });

  it("should update the total swap request fee for unfulfilled request", async () => {
    const amount = parseEther("5");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    const tx = await router
      .connect(user)
      .requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipient.address);

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
      .requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipient.address);

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
      .requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipient.address);

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

    // Step 1. Fetch transfer parameters from the chain using the request id
    const swapRequestParams = await router.getSwapRequestParameters(requestId);

    const [, , messageAsG1Point] = await router.swapRequestParametersToBytes(requestId);

    // Step 2: Message from EVM
    const M = bn254.G1.ProjectivePoint.fromAffine({
      x: BigInt(messageAsG1Point[0]),
      y: BigInt(messageAsG1Point[1]),
    });

    // Step 3: Sign message
    const sigPoint = bn254.signShortSignature(M, privKeyBytes);

    // Step 4: Serialize signature (x, y) for EVM
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
    await router.connect(owner).rebalanceSolver(solver.address, requestId, sigBytes);

    const after = await srcToken.balanceOf(solverAddr);
    expect(after - before).to.equal(amount + swapRequestParams.solverFee - swapRequestParams.verificationFee);
    expect(await srcToken.balanceOf(await router.getAddress())).to.be.equal(swapRequestParams.verificationFee);

    expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(1);
    expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(0);
  });

  it("should relay tokens and store a receipt", async () => {
    const amount = parseEther("10");
    const requestId = keccak256(toUtf8Bytes("test"));
    const srcChainId = 1;

    // Check recipient balance before transfer
    expect(await srcToken.balanceOf(recipientAddr)).to.equal(0);

    // Mint tokens for user
    await srcToken.mint(userAddr, amount);

    // Approve Router to spend user's tokens
    await srcToken.connect(user).approve(await router.getAddress(), amount);

    // Relay tokens
    await expect(
      router.connect(user).relayTokens(await srcToken.getAddress(), recipientAddr, amount, requestId, srcChainId),
    ).to.emit(router, "SwapRequestFulfilled");

    // Check recipient balance after transfer
    expect(await srcToken.balanceOf(recipientAddr)).to.equal(amount);

    // Check receipt
    const receipt = await router.swapRequestReceipts(requestId);
    expect(receipt.fulfilled).to.be.true;
    expect(receipt.amountOut).to.equal(amount);
    expect(receipt.solver).to.equal(userAddr);

    expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
    expect((await router.getFulfilledTransfers()).length).to.be.equal(1);

    await expect(
      router.connect(user).relayTokens(await srcToken.getAddress(), recipientAddr, amount, requestId, srcChainId),
    ).to.revertedWithCustomError(router, "AlreadyFulfilled()");

    expect((await router.getFulfilledTransfers()).length).to.be.equal(1);
  });

  it("should not allow double fulfillment", async () => {
    const amount = parseEther("5");
    const requestId = keccak256(toUtf8Bytes("duplicate"));
    const srcChainId = 100;

    // Mint tokens for user
    await dstToken.mint(userAddr, amount);
    await dstToken.connect(user).approve(await router.getAddress(), amount);
    const tx = await router
      .connect(user)
      .relayTokens(await dstToken.getAddress(), recipientAddr, amount, requestId, srcChainId);
    const receipt = await tx.wait();
    const blockNumber = await ethers.provider.getBlock(receipt!.blockNumber);
    const timestamp = blockNumber!.timestamp;

    if (!receipt) {
      throw new Error("transaction has not been mined");
    }

    const routerInterface = Router__factory.createInterface();
    const [reqId, sourceChainId, token, solver, recipient, , fulfilledAt] = extractSingleLog(
      routerInterface,
      receipt,
      await router.getAddress(),
      routerInterface.getEvent("SwapRequestFulfilled"),
    );

    expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
    expect((await router.getFulfilledTransfers()).length).to.be.equal(1);

    // Try again with same requestId
    await dstToken.connect(user).approve(await router.getAddress(), amount);
    await expect(
      router.connect(user).relayTokens(await dstToken.getAddress(), recipientAddr, amount, requestId, srcChainId),
    ).to.revertedWithCustomError(router, "AlreadyFulfilled()");

    expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
    expect((await router.getFulfilledTransfers()).length).to.be.equal(1);
  });

  it("relay receipt parameters should match event parameters", async () => {
    const amount = parseEther("5");
    const requestId = keccak256(toUtf8Bytes("duplicate"));
    const srcChainId = 100;

    // Mint tokens for user
    await dstToken.mint(userAddr, amount);
    await dstToken.connect(user).approve(await router.getAddress(), amount);
    const tx = await router
      .connect(user)
      .relayTokens(await dstToken.getAddress(), recipientAddr, amount, requestId, srcChainId);
    const receipt = await tx.wait();
    const blockNumber = await ethers.provider.getBlock(receipt!.blockNumber);
    const timestamp = blockNumber!.timestamp;

    if (!receipt) {
      throw new Error("transaction has not been mined");
    }

    const routerInterface = Router__factory.createInterface();
    const [reqId, sourceChainId, , token, solver, recipient, , fulfilledAt] = extractSingleLog(
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
    expect(swapRequestReceipt[8]).to.equal(timestamp);

    // Check receipt values compared to emitted event
    expect(reqId).to.equal(swapRequestReceipt[0]);
    expect(sourceChainId).to.equal(swapRequestReceipt[1]);
    expect(token).to.equal(await dstToken.getAddress());
    expect(solver).to.equal(userAddr);
    expect(recipient).to.equal(recipientAddr);
    expect(amount).to.equal(amount);
    expect(fulfilledAt).to.equal(timestamp);
  });

  it("should return correct isFulfilled status", async () => {
    const amount = parseEther("1");
    const requestId = keccak256(toUtf8Bytes("status"));
    const srcChainId = 250;

    // Mint tokens for user
    await srcToken.mint(userAddr, amount);
    await srcToken.connect(user).approve(await router.getAddress(), amount);
    await router.connect(user).relayTokens(await srcToken.getAddress(), recipientAddr, amount, requestId, srcChainId);

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
      router.connect(user).requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipientAddr),
    ).to.be.revertedWithCustomError(router, "ZeroAmount()");
  });

  it("should revert if destination chain is not permitted", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount + fee;
    const invalidChainId = 9999;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    await expect(
      router
        .connect(user)
        .requestCrossChainSwap(await srcToken.getAddress(), amount, fee, invalidChainId, recipientAddr),
    ).to.be.revertedWithCustomError(router, "TokenNotSupported()");
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
      router.connect(user).requestCrossChainSwap(await srcToken.getAddress(), amount, fee, newChainId, recipientAddr),
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
      .requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipient.address);

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
    const swapRequestParams = await router.getSwapRequestParameters(requestId);
    const [, , messageAsG1Point] = await router.swapRequestParametersToBytes(requestId);
    const M = bn254.G1.ProjectivePoint.fromAffine({
      x: BigInt(messageAsG1Point[0]),
      y: BigInt(messageAsG1Point[1]),
    });
    const sigPoint = bn254.signShortSignature(M, privKeyBytes);
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
    const amount = parseEther("0");
    const requestId = keccak256(toUtf8Bytes("zero-amount"));
    const srcChainId = 1;

    await srcToken.mint(userAddr, amount);
    await srcToken.connect(user).approve(await router.getAddress(), amount);

    await expect(
      router.connect(user).relayTokens(await srcToken.getAddress(), recipientAddr, amount, requestId, srcChainId),
    ).to.be.revertedWithCustomError(router, "ZeroAmount()");
  });

  it("should revert if relayTokens is called with zero address as recipient", async () => {
    const amount = parseEther("1");
    const requestId = keccak256(toUtf8Bytes("zero-recipient"));
    const srcChainId = 1;

    await srcToken.mint(userAddr, amount);
    await srcToken.connect(user).approve(await router.getAddress(), amount);

    await expect(
      router.connect(user).relayTokens(await srcToken.getAddress(), ethers.ZeroAddress, amount, requestId, srcChainId),
    ).to.be.revertedWithCustomError(router, "InvalidTokenOrRecipient()");
  });

  it("should revert if trying to approve more tokens than balance", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount; // Not enough for fee

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint + fee);

    await expect(
      router.connect(user).requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipientAddr),
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
      .requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipient.address);

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
});

// returns the first instance of an event log from a transaction receipt that matches the address provided
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
