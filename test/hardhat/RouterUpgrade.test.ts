import {
  Router,
  Router__factory,
  MockRouterV2,
  MockRouterV2__factory,
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
  ZeroAddress,
} from "ethers";
import { ethers } from "hardhat";

const DST_CHAIN_ID = 137;

const VERIFICATION_FEE_BPS = 500;

describe("RouterUpgrade", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let solver: SignerWithAddress;
  let recipient: SignerWithAddress;

  let router: Router;
  let srcToken: ERC20Token;
  let dstToken: ERC20Token;
  let swapBn254SigScheme: BN254SignatureScheme;
  let upgradeBn254SigScheme: BN254SignatureScheme;

  let privKeyBytes: Uint8Array;
  let ownerAddr: string, solverAddr: string, userAddr: string, recipientAddr: string;

  const bridgeType = 0;
  const upgradeType = 1;

  async function generateSignature(
    action: string,
    contractAddress: string,
    calldata: string,
    upgradeTime: number,
    currentNonce: number
  ): Promise<string> {
    const [, , messageAsG1Point] = await router.contractUpgradeParamsToBytes(
      action,
      contractAddress,
      calldata,
      upgradeTime,
      currentNonce
    );
    const M = bn254.G1.ProjectivePoint.fromAffine({
      x: BigInt(messageAsG1Point[0]),
      y: BigInt(messageAsG1Point[1]),
    });
    const sigPoint = bn254.signShortSignature(M, privKeyBytes);
    const sigPointToAffine = sigPoint.toAffine();
    return AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [sigPointToAffine.x, sigPointToAffine.y]);
  }

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
    swapBn254SigScheme = await new BN254SignatureScheme__factory(owner).deploy([x.c1, x.c0], [y.c1, y.c0], bridgeType);
    upgradeBn254SigScheme = await new BN254SignatureScheme__factory(owner).deploy(
      [x.c1, x.c0],
      [y.c1, y.c0],
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

  describe("scheduleUpgrade", () => {
    it("should schedule an upgrade with valid params (good path)", async () => {
      const version = await router.getVersion();
      expect(version).to.equal("1.0.0");

      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
      await expect(
        router.connect(owner).scheduleUpgrade(ZeroAddress, "0x", upgradeTime, sigBytes),
      ).to.be.reverted;
    });

    it("should revert if upgrade time is not in the future (bad path)", async () => {
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
  });

  describe("cancelUpgrade", () => {
    it("should cancel a scheduled upgrade with valid signature signed over message from router.contractUpgradeParamsToBytes() (good path)", async () => {
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
      expect(version).to.equal("1.0.0");
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
      expect(version).to.equal("2.0.0");
    });

    it("should revert if upgradeToAndCall is called extrenally (bad path)", async () => {
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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

    it("should not affect contract storage and token configurations after upgrade (good path)", async () => {
      // Check ADMIN_ROLE before upgrade
      const ADMIN_ROLE = keccak256(toUtf8Bytes("ADMIN_ROLE"));
      const hasAdminRoleBefore = await router.hasRole(ADMIN_ROLE, ownerAddr);
      expect(hasAdminRoleBefore).to.be.true;
      // Check token mapping before upgrade
      const dstTokenAddressBefore = await router.getTokenMapping(await srcToken.getAddress(), DST_CHAIN_ID);
      expect(dstTokenAddressBefore[0]).to.equal(await dstToken.getAddress());

      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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

      // Check ADMIN_ROLE after upgrade
      const hasAdminRoleAfter = await router.hasRole(ADMIN_ROLE, ownerAddr);
      expect(hasAdminRoleAfter).to.be.true;
      // Check token mapping after upgrade
      const dstTokenAddressAfter = await router.getTokenMapping(await srcToken.getAddress(), DST_CHAIN_ID);
      expect(dstTokenAddressAfter[0]).to.equal(await dstToken.getAddress());
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

    it("should revert if initialize is called again after upgrade (bad path)", async () => {
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
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
