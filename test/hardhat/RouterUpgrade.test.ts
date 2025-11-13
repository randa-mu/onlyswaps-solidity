import {
  MockRouterV1,
  MockRouterV1__factory,
  MockRouterV2,
  MockRouterV2__factory,
  ERC20Token,
  ERC20Token__factory,
  BLSBN254SignatureScheme,
  BLSBN254SignatureScheme__factory,
  UUPSProxy__factory,
  Permit2Relayer,
  Permit2Relayer__factory,
  Permit2__factory,
  Permit2,
} from "../../typechain-types";
import { extractSingleLog, EMPTY_HOOKS } from "./utils/utils";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { AbiCoder, keccak256, toUtf8Bytes, ZeroAddress, parseEther, MaxUint256, TypedDataEncoder } from "ethers";
import { ethers } from "hardhat";

const DST_CHAIN_ID = 137;

const VERIFICATION_FEE_BPS = 500;

describe("Router Upgrade", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let recipient: SignerWithAddress;

  let router: MockRouterV1;
  let srcToken: ERC20Token;
  let dstToken: ERC20Token;
  let swapBn254SigScheme: BLSBN254SignatureScheme;
  let upgradeBn254SigScheme: BLSBN254SignatureScheme;
  let permit2: Permit2;
  let permit2Relayer: Permit2Relayer;

  let privKeyBytes: Uint8Array;
  let ownerAddr: string;

  const swapType = "swap-v1";
  const upgradeType = "upgrade-v1";

  async function generateSignature(
    action: string,
    contractAddress: string,
    calldata: string,
    upgradeTime: number,
    currentNonce: number,
  ): Promise<string> {
    const [, messageAsG1Bytes] = await router.contractUpgradeParamsToBytes(
      action,
      await router.scheduledImplementation(),
      contractAddress,
      calldata,
      upgradeTime,
      currentNonce,
    );
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
    [owner, user, recipient] = await ethers.getSigners();

    ownerAddr = await owner.getAddress();

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

    const Router = new ethers.ContractFactory(MockRouterV1__factory.abi, MockRouterV1__factory.bytecode, owner);

    // Deploy Router implementation
    const routerImplementation: MockRouterV1 = await new MockRouterV1__factory(owner).deploy();
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
    const routerAttached = MockRouterV1__factory.connect(await routerProxy.getAddress(), owner);
    router = routerAttached;

    // Router contract configuration
    await router.connect(owner).permitDestinationChainId(DST_CHAIN_ID);
    await router.connect(owner).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());
  });

  describe("scheduleUpgrade", () => {
    it("should schedule an upgrade with valid params (good path)", async () => {
      const version = await router.getVersion();
      expect(version).to.equal("1.1.0");

      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);
      await expect(router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes))
        .to.emit(router, "UpgradeScheduled")
        .withArgs(newImplAddress, upgradeTime);
    });

    it("should revert if new implementation address is zero (bad path)", async () => {
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", ZeroAddress, "0x", upgradeTime, currentNonce);
      await expect(router.connect(owner).scheduleUpgrade(ZeroAddress, "0x", upgradeTime, sigBytes)).to.be.reverted;
    });

    it("should revert if upgrade time is not in the future (bad path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp - 10 : 0; // 10 seconds in the past
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);
      await expect(router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes))
        .to.be.revertedWithCustomError(router, "UpgradeTimeMustRespectDelay")
        .withArgs(await router.getMinimumContractUpgradeDelay());
    });

    it("should not revert if called by non-admin (good path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");

      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);

      const tx = await router.connect(user).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);
      await expect(tx).to.emit(router, "UpgradeScheduled").withArgs(newImplAddress, upgradeTime);
    });

    it("should schedule upgrade with non-empty data (good path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future

      // Prepare initialization data for the new implementation
      const calldata = router.interface.encodeFunctionData("getVersion");

      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, calldata, upgradeTime, currentNonce);

      await expect(router.connect(owner).scheduleUpgrade(newImplAddress, calldata, upgradeTime, sigBytes))
        .to.emit(router, "UpgradeScheduled")
        .withArgs(newImplAddress, upgradeTime);
    });

    it("should revert if scheduled upgrade address is the same as a pending upgrade (bad path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      let currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);

      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);

      currentNonce = Number(await router.currentNonce()) + 1;
      sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime + 1000, currentNonce);

      await expect(
        router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime + 1000, sigBytes),
      ).to.be.revertedWithCustomError(router, "SameVersionUpgradeNotAllowed");
    });

    it("should upgrade to MockRouterV2 with swap request nonce functionality without affecting existing requests and storage layout (good path)", async () => {
      // Create an existing swap request in Router v1 to ensure it's preserved
      const swapAmount = ethers.parseEther("100");
      const solverFee = ethers.parseEther("1");
      const totalAmount = swapAmount + solverFee;

      await srcToken.connect(user).mint(await user.getAddress(), totalAmount);
      await srcToken.connect(user).approve(await router.getAddress(), totalAmount);

      // Create a swap request in Router v1
      const swapRequestTx = await router
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          swapAmount,
          solverFee,
          DST_CHAIN_ID,
          await recipient.getAddress(),
        );
      const swapRequestReceipt = await swapRequestTx.wait();

      // Extract the swap request ID from the event
      const routerInterface = MockRouterV1__factory.createInterface();
      const [swapRequestId] = extractSingleLog(
        routerInterface,
        swapRequestReceipt!,
        await router.getAddress(),
        routerInterface.getEvent("SwapRequested"),
      );

      // Verify the swap request exists in Router v1
      expect(swapRequestId).to.not.be.undefined;
      const swapRequestParams = await router.getSwapRequestParameters(swapRequestId);
      expect(swapRequestParams.executed).to.be.false;

      // Check current contract nonce before upgrade
      const contractNonceBefore = await router.currentNonce();

      // Check existing storage values before upgrade
      const ADMIN_ROLE = keccak256(toUtf8Bytes("ADMIN_ROLE"));
      const hasAdminRoleBefore = await router.hasRole(ADMIN_ROLE, ownerAddr);
      const dstTokenAddressBefore = await router.getTokenMapping(await srcToken.getAddress(), DST_CHAIN_ID);
      const versionBefore = await router.getVersion();

      expect(hasAdminRoleBefore).to.be.true;
      expect(dstTokenAddressBefore[0]).to.equal(await dstToken.getAddress());
      expect(versionBefore).to.equal("1.1.0");

      // Now we perform the upgrade to MockRouterV2
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future

      let currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);

      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);

      await ethers.provider.send("evm_increaseTime", [upgradeTime]);
      await ethers.provider.send("evm_mine", []);

      await router.connect(user).executeUpgrade();

      // Connect to the upgraded contract with MockRouterV2 interface
      const upgradedRouter = MockRouterV2__factory.connect(await router.getAddress(), user);

      // Verify the upgrade was successful
      const versionAfter = await upgradedRouter.getVersion();
      expect(versionAfter).to.equal("1.1.2");

      // Verify all existing storage is preserved
      const hasAdminRoleAfter = await upgradedRouter.hasRole(ADMIN_ROLE, ownerAddr);
      const dstTokenAddressAfter = await upgradedRouter.getTokenMapping(await srcToken.getAddress(), DST_CHAIN_ID);
      const contractNonceAfter = await upgradedRouter.currentNonce();

      expect(hasAdminRoleAfter).to.be.true;
      expect(dstTokenAddressAfter[0]).to.equal(await dstToken.getAddress());
      // Contract nonce should be preserved, but incremented by 1 since we executed an upgrade
      expect(contractNonceAfter).to.equal(contractNonceBefore + 1n);

      // Verify existing swap request is still accessible and unchanged
      const swapRequestParamsAfter = await upgradedRouter.getSwapRequestParameters(swapRequestId);
      expect(swapRequestParamsAfter.executed).to.be.false;
      expect(swapRequestParamsAfter.amountOut).to.equal(swapRequestParams.amountOut);
      expect(swapRequestParamsAfter.solverFee).to.equal(swapRequestParams.solverFee);
      expect(swapRequestParamsAfter.nonce).to.equal(1);
      // expect empty hooks to be retrievable after upgrade and addition of hooks to struct returned by getSwapRequestParameters
      expect(swapRequestParamsAfter.preHooks.length).to.equal(0);
      expect(swapRequestParamsAfter.postHooks.length).to.equal(0);

      // Verify contract balance from existing swap request is still intact
      const routerBalance = await srcToken.balanceOf(await upgradedRouter.getAddress());
      expect(routerBalance).to.equal(totalAmount);

      // At this point, we have verified that the upgrade preserved all existing state and functionality.
      // Now we can test the new functionality introduced in MockRouterV2.

      // Verify new functionality is available (swap request nonce)
      expect(await upgradedRouter.testNewFunctionality()).to.be.true;

      // Test the new swap request nonce functionality
      const initialcurrentSwapRequestNonce = await upgradedRouter.currentSwapRequestNonce();
      expect(initialcurrentSwapRequestNonce).to.equal(1); // Should start at 1 for new functionality

      // Create a new swap request to test the new nonce functionality
      await srcToken.connect(owner).mint(await user.getAddress(), totalAmount);
      await srcToken.connect(user).approve(await upgradedRouter.getAddress(), totalAmount);

      await upgradedRouter
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          swapAmount,
          swapAmount,
          solverFee,
          DST_CHAIN_ID,
          await recipient.getAddress(),
          EMPTY_HOOKS.preHooks,
          EMPTY_HOOKS.postHooks
        );

      // Verify the swap request nonce incremented
      const currentSwapRequestNonceAfter = await upgradedRouter.currentSwapRequestNonce();
      expect(currentSwapRequestNonceAfter).to.equal(2);

      // Test that we can create multiple swap requests and nonce keeps incrementing
      await srcToken.connect(owner).mint(await user.getAddress(), totalAmount);
      await srcToken.connect(user).approve(await upgradedRouter.getAddress(), totalAmount);

      await upgradedRouter
        .connect(user)
        .requestCrossChainSwap(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          swapAmount,
          swapAmount,
          solverFee,
          DST_CHAIN_ID,
          await recipient.getAddress(),
          EMPTY_HOOKS.preHooks,
          EMPTY_HOOKS.postHooks
        );

      const finalcurrentSwapRequestNonce = await upgradedRouter.currentSwapRequestNonce();
      expect(finalcurrentSwapRequestNonce).to.equal(3);

      // Verify that the contract nonce (for upgrades) is still independent and unchanged
      const finalContractNonce = await upgradedRouter.currentNonce();
      expect(finalContractNonce).to.equal(contractNonceAfter);
    });
  });

  describe("cancelUpgrade", () => {
    it("should cancel a scheduled upgrade with valid signature signed over message from router.contractUpgradeParamsToBytes() (good path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      let currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);

      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);

      currentNonce = Number(await router.currentNonce()) + 1;
      sigBytes = await generateSignature("cancel", newImplAddress, "0x", upgradeTime, currentNonce);

      // Cancel the upgrade
      await expect(router.connect(owner).cancelUpgrade(sigBytes))
        .to.emit(router, "UpgradeCancelled")
        .withArgs(newImplAddress);
    });

    it("should revert if BLS signature verification fails (bad path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);

      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);

      // Generate an invalid signature (random bytes)
      const invalidSigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [BigInt(keccak256(toUtf8Bytes("invalid1"))), BigInt(keccak256(toUtf8Bytes("invalid2")))],
      );

      // Attempt to cancel the upgrade with the invalid signature
      await expect(router.connect(owner).cancelUpgrade(invalidSigBytes)).to.be.revertedWithCustomError(
        router,
        "BLSSignatureVerificationFailed()",
      );
    });

    it("should revert if it is too late to cancel (bad path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      let currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);

      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);
      await ethers.provider.send("evm_increaseTime", [upgradeTime + 1]); // Increase time by 20 seconds
      await ethers.provider.send("evm_mine", []); // Mine a new block to reflect the time change

      currentNonce = Number(await router.currentNonce()) + 1;
      sigBytes = await generateSignature("cancel", newImplAddress, "0x", upgradeTime, currentNonce);

      await expect(router.connect(owner).cancelUpgrade(sigBytes))
        .to.be.revertedWithCustomError(router, "TooLateToCancelUpgrade")
        .withArgs(upgradeTime);
    });
  });

  describe("executeUpgrade", () => {
    it("should execute a scheduled upgrade after scheduled time (good path)", async () => {
      let version = await router.getVersion();
      expect(version).to.equal("1.1.0");
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");

      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);
      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);

      await ethers.provider.send("evm_increaseTime", [upgradeTime]);
      await ethers.provider.send("evm_mine", []); // Mine a new block to reflect the time change
      // Execute the upgrade. It can be called by anyone
      await expect(router.connect(user).executeUpgrade()).to.emit(router, "UpgradeExecuted").withArgs(newImplAddress);
      // Check version after upgrade
      version = await router.getVersion();
      expect(version).to.equal("1.1.2");
    });

    it("should revert if upgradeToAndCall is called extrenally (bad path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");

      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);

      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);
      await expect(router.connect(user).upgradeToAndCall(newImplAddress, "0x")).to.be.revertedWithCustomError(
        router,
        "UpgradeMustGoThroughExecuteUpgrade()",
      );
    });

    it("should revert if current scheduled implementation address is zero address (bad path)", async () => {
      await expect(router.connect(user).executeUpgrade()).to.be.revertedWithCustomError(router, "NoUpgradePending()");
    });

    it("should revert if upgrade is called too early (bad path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);
      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);
      await expect(router.connect(user).executeUpgrade())
        .to.be.revertedWithCustomError(router, "UpgradeTooEarly")
        .withArgs(upgradeTime);
    });

    it("should not affect contract storage layout and token configurations after upgrade (good path)", async () => {
      // Check ADMIN_ROLE before upgrade
      const ADMIN_ROLE = keccak256(toUtf8Bytes("ADMIN_ROLE"));
      const hasAdminRoleBefore = await router.hasRole(ADMIN_ROLE, ownerAddr);
      expect(hasAdminRoleBefore).to.be.true;
      // Check token mapping before upgrade
      const dstTokenAddressBefore = await router.getTokenMapping(await srcToken.getAddress(), DST_CHAIN_ID);
      expect(dstTokenAddressBefore[0]).to.equal(await dstToken.getAddress());

      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");

      const latestUpgradeNonce = Number(await router.currentNonce());
      const latestSwapRequestNonce = Number(await router.currentSwapRequestNonce());

      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;

      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);

      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);
      await ethers.provider.send("evm_increaseTime", [upgradeTime]);
      await ethers.provider.send("evm_mine", []); // Mine a new block to reflect the time change
      await router.connect(user).executeUpgrade();

      // Check ADMIN_ROLE after upgrade
      const hasAdminRoleAfter = await router.hasRole(ADMIN_ROLE, ownerAddr);
      expect(hasAdminRoleAfter).to.be.true;
      // Check token mapping after upgrade
      const dstTokenAddressAfter = await router.getTokenMapping(await srcToken.getAddress(), DST_CHAIN_ID);
      expect(dstTokenAddressAfter[0]).to.equal(await dstToken.getAddress());
      // Check nonces after upgrade
      const latestUpgradeNonceAfter = Number(await router.currentNonce());
      const latestSwapRequestNonceAfter = Number(await router.currentSwapRequestNonce());

      expect(latestUpgradeNonceAfter).to.equal(latestUpgradeNonce + 1); // Incremented by 1 due to upgrade
      expect(latestSwapRequestNonceAfter).to.equal(latestSwapRequestNonce); // Should remain unchanged
    });

    it("should have new functionality after upgrade (good path)", async () => {
      // Function testNewFunctionality() external pure returns (bool) should be callable after upgrade to MockRouterV2;
      let upgradedRouter = MockRouterV2__factory.connect(await router.getAddress(), user);
      await expect(upgradedRouter.testNewFunctionality()).to.be.reverted; // Should revert since the function doesn't exist yet

      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);
      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);
      await ethers.provider.send("evm_increaseTime", [upgradeTime]);
      await ethers.provider.send("evm_mine", []); // Mine a new block to reflect the time change
      await router.connect(user).executeUpgrade();

      upgradedRouter = MockRouterV2__factory.connect(await router.getAddress(), user);
      expect(await upgradedRouter.testNewFunctionality()).to.be.true; // Should return true after upgrade
    });

    it("should make a swap request with a valid Permit2 signature after upgrade and emit swap requested event without affecting storage layout", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      const userAddr = await user.getAddress();
      const recipientAddr = await recipient.getAddress();

      await srcToken.mint(await user.getAddress(), amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      await expect(
        router
          .connect(user)
          .requestCrossChainSwap(
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            solverFee,
            DST_CHAIN_ID,
            await recipient.getAddress(),
          ),
      ).to.emit(router, "SwapRequested");

      // Now upgrade to MockRouterV2
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);
      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);
      await ethers.provider.send("evm_increaseTime", [upgradeTime]);
      await ethers.provider.send("evm_mine", []); // Mine a new block to reflect the time change
      await router.connect(user).executeUpgrade();

      // Verify upgrade was successful
      const version = await router.getVersion();
      expect(version).to.equal("1.1.2");

      // Verify storage layout is preserved
      const ADMIN_ROLE = keccak256(toUtf8Bytes("ADMIN_ROLE"));
      const hasAdminRole = await router.hasRole(ADMIN_ROLE, ownerAddr);
      expect(hasAdminRole).to.be.true;
      const dstTokenAddress = await router.getTokenMapping(await srcToken.getAddress(), DST_CHAIN_ID);
      expect(dstTokenAddress[0]).to.equal(await dstToken.getAddress());
      const latestUpgradeNonce = Number(await router.currentNonce());
      const latestSwapRequestNonce = Number(await router.currentSwapRequestNonce());

      expect(latestSwapRequestNonce).to.equal(1); // Should remain unchanged after upgrade
      expect(latestUpgradeNonce).to.equal(1); // Should be incremented by 1 due to upgrade

      // Connect to the upgraded contract with MockRouterV2 interface
      const upgradedRouter = MockRouterV2__factory.connect(await router.getAddress(), user);

      // Set Permit2Relayer as approved relayer in Permit2
      await upgradedRouter.connect(owner).setPermit2Relayer(await permit2Relayer.getAddress());

      // Now create a swap request using Permit2 signature

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
          amountIn: amount.toString(),
          amountOut: amount.toString(),
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
        amountIn: amount,
        amountOut: amount,
        solverFee: solverFee,
        dstChainId: DST_CHAIN_ID,
        recipient: recipientAddr,
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,
        preHooks: EMPTY_HOOKS.preHooks,
        postHooks: EMPTY_HOOKS.postHooks
      };

      await expect(upgradedRouter.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params)).to.emit(
        upgradedRouter,
        "SwapRequested",
      );

      // // Verify storage layout is preserved
      // const hasAdminRoleAfter = await upgradedRouter.hasRole(ADMIN_ROLE, ownerAddr);
      // expect(hasAdminRoleAfter).to.be.true;
      // const dstTokenAddressAfter = await upgradedRouter.getTokenMapping(await srcToken.getAddress(), DST_CHAIN_ID);
      // expect(dstTokenAddressAfter[0]).to.equal(await dstToken.getAddress());
      // const latestUpgradeNonceAfter = Number(await upgradedRouter.currentNonce());
      // const latestSwapRequestNonceAfter = Number(await upgradedRouter.currentSwapRequestNonce());

      // expect(latestUpgradeNonceAfter).to.equal(latestUpgradeNonce); // Should remain unchanged after swap request
      // expect(latestSwapRequestNonceAfter).to.equal(latestSwapRequestNonce + 1); // Incremented by 1 due to new swap request
    });

    it("should revert if initialize is called again after upgrade (bad path)", async () => {
      const newImplementation: MockRouterV2 = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 172800 + 1 : 0; // 2 days in the future
      const currentNonce = Number(await router.currentNonce()) + 1;
      let sigBytes = await generateSignature("schedule", newImplAddress, "0x", upgradeTime, currentNonce);
      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime, sigBytes);
      await ethers.provider.send("evm_increaseTime", [upgradeTime]);
      await ethers.provider.send("evm_mine", []); // Mine a new block to reflect the time change
      await router.connect(user).executeUpgrade();
      await expect(
        router
          .connect(user)
          .initialize(
            ownerAddr,
            await swapBn254SigScheme.getAddress(),
            await upgradeBn254SigScheme.getAddress(),
            VERIFICATION_FEE_BPS,
          ),
      ).to.be.revertedWithCustomError(router, "InvalidInitialization()");
    });
  });
});
