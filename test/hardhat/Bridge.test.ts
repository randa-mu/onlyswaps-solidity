import { Bridge, Bridge__factory, ERC20Token, ERC20Token__factory } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { parseEther, keccak256, toUtf8Bytes } from "ethers";
import { ethers } from "hardhat";

describe("Bridge", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let recipient: SignerWithAddress;

  let ownerAddr: string, userAddr: string, recipientAddr: string;

  let bridge: Bridge;
  let token: ERC20Token;

  beforeEach(async () => {
    [owner, user, recipient] = await ethers.getSigners();

    ownerAddr = await owner.getAddress();
    userAddr = await user.getAddress();
    recipientAddr = await recipient.getAddress();

    // Deploy token contract
    token = await new ERC20Token__factory(owner).deploy("RUSD", "RUSD", 18);

    // Deploy Bridge contract
    bridge = await new Bridge__factory(owner).deploy(ownerAddr);
  });

  it("should relay tokens and store a receipt", async () => {
    const amount = parseEther("10");
    const requestId = keccak256(toUtf8Bytes("test"));
    const srcChainId = 1;

    // Check recipient balance before transfer
    expect(await token.balanceOf(recipientAddr)).to.equal(0);

    // Mint tokens for user
    await token.mint(userAddr, amount);

    // Approve Bridge to spend user's tokens
    await token.connect(user).approve(await bridge.getAddress(), amount);

    // Relay tokens
    await expect(
      bridge.connect(user).relayTokens(await token.getAddress(), recipientAddr, amount, requestId, srcChainId),
    ).to.emit(bridge, "BridgeReceipt");

    // Check recipient balance after transfer
    expect(await token.balanceOf(recipientAddr)).to.equal(amount);

    // Check receipt
    const receipt = await bridge.receipts(requestId);
    expect(receipt.fulfilled).to.be.true;
    expect(receipt.amountOut).to.equal(amount);
    expect(receipt.solver).to.equal(userAddr);

    expect(await bridge.isFulfilled(requestId)).to.be.equal(true);

    await expect(
      bridge.connect(user).relayTokens(await token.getAddress(), recipientAddr, amount, requestId, srcChainId),
    ).to.revertedWith("Already fulfilled");
  });

  it("should not allow double fulfillment", async () => {
    const amount = parseEther("5");
    const requestId = keccak256(toUtf8Bytes("duplicate"));
    const srcChainId = 100;

    // Mint tokens for user
    await token.mint(userAddr, amount);
    await token.connect(user).approve(await bridge.getAddress(), amount);
    await bridge.connect(user).relayTokens(await token.getAddress(), recipientAddr, amount, requestId, srcChainId);

    // Try again with same requestId
    await token.connect(user).approve(await bridge.getAddress(), amount);
    await expect(
      bridge.connect(user).relayTokens(await token.getAddress(), recipientAddr, amount, requestId, srcChainId),
    ).to.be.revertedWith("Already fulfilled");
  });

  it("should return correct isFulfilled status", async () => {
    const amount = parseEther("1");
    const requestId = keccak256(toUtf8Bytes("status"));
    const srcChainId = 250;

    // Mint tokens for user
    await token.mint(userAddr, amount);
    await token.connect(user).approve(await bridge.getAddress(), amount);
    await bridge.connect(user).relayTokens(await token.getAddress(), recipientAddr, amount, requestId, srcChainId);

    expect(await bridge.isFulfilled(requestId)).to.be.true;
    const fakeId = keccak256(toUtf8Bytes("non-existent"));
    expect(await bridge.isFulfilled(fakeId)).to.be.false;
  });

  it("should allow owner to rescue ERC20 tokens", async () => {
    const rescueAmount = parseEther("20");

    // Mint tokens for user
    await token.mint(userAddr, rescueAmount);
    // Transfer tokens directly to the bridge
    await token.connect(user).transfer(await bridge.getAddress(), rescueAmount);
    expect(await token.balanceOf(await bridge.getAddress())).to.equal(rescueAmount);

    // Rescue as owner
    await bridge.connect(owner).rescueERC20(await token.getAddress(), ownerAddr, rescueAmount);
    expect(await token.balanceOf(ownerAddr)).to.equal(rescueAmount);
  });

  it("should not allow non-owner to rescue tokens", async () => {
    const rescueAmount = parseEther("5");
    // Mint tokens for user
    await token.mint(userAddr, rescueAmount);
    await token.connect(user).transfer(await bridge.getAddress(), rescueAmount);

    await expect(bridge.connect(user).rescueERC20(await token.getAddress(), userAddr, rescueAmount))
      .to.be.revertedWithCustomError(bridge, "OwnableUnauthorizedAccount")
      .withArgs(await user.getAddress());
  });
});
