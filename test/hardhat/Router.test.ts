import {
  Router,
  Router__factory,
  ERC20Token,
  ERC20Token__factory,
  BN254SignatureScheme,
  BN254SignatureScheme__factory,
} from "../../typechain-types";
import { BlsBn254 } from "./crypto";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import dotenv from "dotenv";
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

dotenv.config();

const blsKey = process.env.BLS_PRIVATE_KEY;
const DST_CHAIN_ID = 137;
const default_pk = {
  x: {
    c0: BigInt("0x2691d39ecc380bfa873911a0b848c77556ee948fb8ab649137d3d3e78153f6ca"),
    c1: BigInt("0x2863e20a5125b098108a5061b31f405e16a069e9ebff60022f57f4c4fd0237bf"),
  },
  y: {
    c0: BigInt("0x193513dbe180d700b189c529754f650b7b7882122c8a1e242a938d23ea9f765c"),
    c1: BigInt("0x11c939ea560caf31f552c9c4879b15865d38ba1dfb0f7a7d2ac46a4f0cae25ba"),
  },
};

describe("Router", function () {
  let mcl: BlsBn254;
  before(async () => {
    mcl = await BlsBn254.create();
  });

  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let solver: SignerWithAddress;
  let recipient: SignerWithAddress;

  let router: Router;
  let srcToken: ERC20Token;
  let dstToken: ERC20Token;
  let bn254SigScheme: BN254SignatureScheme;

  let ownerAddr: string, solverAddr: string, userAddr: string, recipientAddr: string;

  beforeEach(async () => {
    [owner, user, solver, recipient] = await ethers.getSigners();

    ownerAddr = await owner.getAddress();
    userAddr = await user.getAddress();
    recipientAddr = await recipient.getAddress();
    solverAddr = await solver.getAddress();

    srcToken = await new ERC20Token__factory(owner).deploy("RUSD", "RUSD", 18);
    dstToken = await new ERC20Token__factory(owner).deploy("RUSD", "RUSD", 18);

    bn254SigScheme = await new BN254SignatureScheme__factory(owner).deploy(
      [default_pk.x.c0, default_pk.x.c1],
      [default_pk.y.c0, default_pk.y.c1],
    );

    // Deploy one router on src chain
    router = await new Router__factory(owner).deploy(ownerAddr, await bn254SigScheme.getAddress());
    // router configuration
    await router.connect(owner).permitDestinationChainId(DST_CHAIN_ID);
    await router.connect(owner).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());
  });

  it("should initiate a bridge request and emit message", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    await expect(
      router.connect(user).requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipientAddr),
    ).to.emit(router, "SwapRequested");
  });

  it("should update bridge fees for unfulfilled request", async () => {
    const amount = parseEther("5");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    const tx = await router
      .connect(user)
      .requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipient.address);

    let receipt = await tx.wait(1);
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

    await expect(router.connect(user).updateFeesIfUnfulfilled(requestId, newFee)).to.emit(
      router,
      "SwapRequestFeeUpdated",
    );

    expect(await srcToken.balanceOf(userAddr)).to.equal(0);

    const transferParams = await router.getTransferParameters(requestId);
    expect(transferParams.swapFee + transferParams.solverFee).to.equal(newFee);
  });

  it("should block non-owner from withdrawing fees", async () => {
    await expect(router.connect(user).withdrawSwapFees(await srcToken.getAddress(), user.address))
      .to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount")
      .withArgs(await user.getAddress());
  });

  it("should allow owner to withdraw bridge fees", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    const tx = await router
      .connect(user)
      .requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipient.address);

    let receipt = await tx.wait(1);
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

    await expect(router.connect(owner).withdrawSwapFees(await srcToken.getAddress(), ownerAddr)).to.emit(
      router,
      "SwapFeesWithdrawn",
    );

    const after = await srcToken.balanceOf(ownerAddr);
    expect(after).to.be.gt(before);

    expect(await router.getTotalSwapFeesBalance(await srcToken.getAddress())).to.equal(0);

    const transferParams = await router.getTransferParameters(requestId);
    expect(await srcToken.balanceOf(await router.getAddress())).to.equal(amount + transferParams.solverFee);
  });

  it("should rebalance solver and transfer correct amount", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    const tx = await router
      .connect(user)
      .requestCrossChainSwap(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipient.address);

    let receipt = await tx.wait(1);
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

    const transferParams = await router.getTransferParameters(requestId);

    const [message, messageAsG1Bytes, messageAsG1Point] = await router.transferParamsToBytes({
      sender: transferParams.sender,
      recipient: transferParams.recipient,
      token: await srcToken.getAddress(),
      amount: transferParams.amount,
      srcChainId: transferParams.srcChainId,
      dstChainId: transferParams.dstChainId,
      swapFee: transferParams.swapFee,
      solverFee: transferParams.solverFee,
      nonce: 1,
      executed: false,
    });
    const M = mcl.g1FromEvm(messageAsG1Point[0], messageAsG1Point[1]);
    const { secretKey, pubKey } = mcl.createKeyPair(blsKey as `0x${string}`);
    const { signature } = mcl.sign(M, secretKey);

    const sig = mcl.serialiseG1Point(signature);
    const sigBytes = AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [sig[0], sig[1]]);

    // ensure router has enough liquidity to pay solver
    expect(await srcToken.balanceOf(await router.getAddress())).to.be.greaterThanOrEqual(
      transferParams.amount + transferParams.solverFee,
    );

    const before = await srcToken.balanceOf(solverAddr);

    expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(0);
    expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(1);

    await router.connect(owner).rebalanceSolver(solver.address, requestId, message, sigBytes);

    const after = await srcToken.balanceOf(solverAddr);
    expect(after - before).to.equal(amount + transferParams.solverFee);
    expect(await srcToken.balanceOf(await router.getAddress())).to.be.equal(transferParams.swapFee);

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

    // Approve Bridge to spend user's tokens
    await srcToken.connect(user).approve(await router.getAddress(), amount);

    // Relay tokens
    await expect(
      router.connect(user).relayTokens(await srcToken.getAddress(), recipientAddr, amount, requestId, srcChainId),
    ).to.emit(router, "BridgeReceipt");

    // Check recipient balance after transfer
    expect(await srcToken.balanceOf(recipientAddr)).to.equal(amount);

    // Check receipt
    const receipt = await router.receipts(requestId);
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
    await srcToken.mint(userAddr, amount);
    await srcToken.connect(user).approve(await router.getAddress(), amount);
    await router.connect(user).relayTokens(await srcToken.getAddress(), recipientAddr, amount, requestId, srcChainId);

    expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
    expect((await router.getFulfilledTransfers()).length).to.be.equal(1);

    // Try again with same requestId
    await srcToken.connect(user).approve(await router.getAddress(), amount);
    await expect(
      router.connect(user).relayTokens(await srcToken.getAddress(), recipientAddr, amount, requestId, srcChainId),
    ).to.revertedWithCustomError(router, "AlreadyFulfilled()");

    expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
    expect((await router.getFulfilledTransfers()).length).to.be.equal(1);
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
