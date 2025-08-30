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
      // TODO: Implement test for scheduling upgrade successfully
      const version = await router.getVersion();
      expect(version).to.equal("1.0.0");
    });

    it("should revert if new implementation address is zero (bad path)", async () => {
      // TODO: Implement test for zero address revert
    });

    it("should revert if upgrade time is not in the future (bad path)", async () => {
      // TODO: Implement test for upgrade time not in the future
    });

    it("should revert if called by non-admin (bad path)", async () => {
      // TODO: Implement test for onlyAdmin modifier
    });
  });

  describe("cancelUpgrade", () => {
    it("should cancel a scheduled upgrade with valid signature (good path)", async () => {
      // TODO: Implement test for successful cancellation
    });

    it("should revert if too late to cancel (bad path)", async () => {
      // TODO: Implement test for too late to cancel
    });

    it("should revert if no upgrade is pending (bad path)", async () => {
      // TODO: Implement test for no upgrade pending
    });

    it("should revert if BLS signature verification fails (bad path)", async () => {
      // TODO: Implement test for BLS signature verification failure
    });
  });

  describe("executeUpgrade", () => {
    it("should execute a scheduled upgrade after scheduled time (good path)", async () => {
      // TODO: Implement test for successful upgrade execution
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
