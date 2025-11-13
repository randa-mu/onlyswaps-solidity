import { ERC20FaucetToken, ERC20FaucetToken__factory } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { parseEther } from "ethers";
import { ethers } from "hardhat";

describe("ERC20FaucetToken", function () {
  let token: ERC20FaucetToken;
  let owner: SignerWithAddress;
  let addr1: SignerWithAddress;

  const initialFaucetAmount = 10;
  const newFaucetAmount = 20;

  beforeEach(async function () {
    [owner, addr1] = await ethers.getSigners();

    token = await new ERC20FaucetToken__factory(owner).deploy(
      "RUSD",
      "RUSD",
      18,
      initialFaucetAmount,
      await owner.getAddress(),
    );
  });

  it("should set a new faucet amount when called by owner", async function () {
    await expect(token.connect(owner).setFaucetAmount(newFaucetAmount))
      .to.emit(token, "FaucetAmountSet")
      .withArgs(newFaucetAmount);

    expect(await token.faucetAmount()).to.equal(newFaucetAmount);
  });

  it("should revert if non-owner tries to set faucet amount", async function () {
    await expect(token.connect(addr1).setFaucetAmount(newFaucetAmount))
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
      .withArgs(await addr1.getAddress());
  });

  it("should mint the correct amounts before and after faucet amount change", async function () {
    // Mint initial amount
    await token.connect(addr1).mint();
    const firstMintBalance = await token.balanceOf(addr1.address);
    expect(firstMintBalance).to.equal(initialFaucetAmount);

    // Set new faucet amount
    await token.connect(owner).setFaucetAmount(newFaucetAmount.toString());

    // Increase time beyond FAUCET_INTERVAL (24 hours)
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]); // add 1 second for safety
    await ethers.provider.send("evm_mine");

    // Mint again
    await token.connect(addr1).mint();
    const totalBalance = await token.balanceOf(addr1.address);

    // Confirm second mint is new faucet amount
    expect(totalBalance).to.equal(initialFaucetAmount + newFaucetAmount);
  });
});
