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

  describe("scheduleUpgrade", () => {
    it("should schedule an upgrade with valid params (good path)", async () => {
      const version = await router.getVersion();
      expect(version).to.equal("1.0.0");

      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 3600 : 0; // 1 hour in the future
      await expect(router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime))
        .to.emit(router, "UpgradeScheduled")
        .withArgs(newImplAddress, upgradeTime);
    });

    it("should revert if new implementation address is zero (bad path)", async () => {
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 3600 : 0; // 1 hour in the future
      await expect(router.connect(owner).scheduleUpgrade(ZeroAddress, "0x", upgradeTime)).to.be.revertedWithCustomError(
        router,
        "ZeroAddress()",
      );
    });

    it("should revert if upgrade time is not in the future (bad path)", async () => {
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp - 10 : 0; // 10 seconds in the past
      await expect(
        router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime),
      ).to.be.revertedWithCustomError(router, "UpgradeTimeMustBeInTheFuture()");
    });

    it("should revert if called by non-admin (bad path)", async () => {
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 3600 : 0; // 1 hour in the future
      await expect(router.connect(user).scheduleUpgrade(newImplAddress, "0x", upgradeTime)).to.be.reverted;
    });

    it("should schedule upgrade with non-empty data (good path)", async () => {
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 3600 : 0; // 1 hour in the future

      // Prepare initialization data for the new implementation
      const calldata = router.interface.encodeFunctionData("getVersion");

      await expect(router.connect(owner).scheduleUpgrade(newImplAddress, calldata, upgradeTime))
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
      const upgradeTime = latestBlock ? latestBlock.timestamp + 3600 : 0; // 1 hour in the future

      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime);

      // Generate the signature for cancellation
      const [, , messageAsG1Point] = await router.contractUpgradeParamsToBytes();

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
      const upgradeTime = latestBlock ? latestBlock.timestamp + 3600 : 0; // 1 hour in the future

      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime);

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

    it("should revert if too late to cancel (bad path)", async () => {
      const newImplementation: Router = await new MockRouterV2__factory(owner).deploy();
      await newImplementation.waitForDeployment();
      const newImplAddress = await newImplementation.getAddress();
      const latestBlock = await ethers.provider.getBlock("latest");
      const upgradeTime = latestBlock ? latestBlock.timestamp + 10 : 0; // 10 seconds in the future
      await router.connect(owner).scheduleUpgrade(newImplAddress, "0x", upgradeTime);
      await ethers.provider.send("evm_increaseTime", [20]); // Increase time by 20 seconds
      await ethers.provider.send("evm_mine", []); // Mine a new block to reflect the time change
      // Generate the signature for cancellation
      const [, , messageAsG1Point] = await router.contractUpgradeParamsToBytes();
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
      await expect(router.connect(owner).cancelUpgrade(sigBytes)).to.be.revertedWithCustomError(
        router,
        "TooLateToCancelUpgrade",
      ).withArgs(upgradeTime);
    });
  });

  describe("executeUpgrade", () => {
    it("should execute a scheduled upgrade after scheduled time (good path)", async () => {
      // TODO: Implement test for successful upgrade execution
    });

    it("should revert if upgradeToAndCall is called extrenally (bad path)", async () => {
      // TODO: Implement test for no upgrade pending
    });

    it("should revert if no upgrade is pending (bad path)", async () => {
      // TODO: Implement test for no upgrade pending
    });

    it("should revert if upgrade is called too early (bad path)", async () => {
      // TODO: Implement test for upgrade too early
    });

    it("should not affect contract storage and token configurations after upgrade (good path)", async () => {
      // TODO: Implement test to ensure storage and configurations are intact after upgrade,
      // including source and destination token mappings
    });

    it("should have new functionality after upgrade (good path)", async () => {
      // TODO: Implement test to ensure new functionality from MockRouterV2 is available after upgrade
    });

    it("should revert if initialize is called again after upgrade (bad path)", async () => {
      // TODO: Implement test to ensure initialize cannot be called again after upgrade
    });
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
