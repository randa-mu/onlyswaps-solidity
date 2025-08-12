import {
  Router,
  Router__factory,
  ERC20Token,
  ERC20Token__factory,
  BN254SignatureScheme,
  BN254SignatureScheme__factory,
  SubscriptionRegistry,
  SubscriptionRegistry__factory,
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

describe("SubscriptionRegistry", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let creator: SignerWithAddress;
  let solver: SignerWithAddress;
  let recipient: SignerWithAddress;

  let router: Router;
  let srcToken: ERC20Token;
  let dstToken: ERC20Token;
  let bn254SigScheme: BN254SignatureScheme;
  let subscriptionRegistry: SubscriptionRegistry;
  let subCode: Uint8Array;

  let privKeyBytes: Uint8Array;
  let ownerAddr: string, solverAddr: string, userAddr: string, recipientAddr: string, creatorAddr: string;

  beforeEach(async () => {
    [owner, user, solver, recipient, creator] = await ethers.getSigners();

    ownerAddr = await owner.getAddress();
    userAddr = await user.getAddress();
    recipientAddr = await recipient.getAddress();
    solverAddr = await solver.getAddress();
    creatorAddr = await creator.getAddress();

    subCode = Uint8Array.from(randomBytes(32));

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
    bn254SigScheme = await new BN254SignatureScheme__factory(owner).deploy([x.c0, x.c1], [y.c0, y.c1]);
    router = await new Router__factory(owner).deploy(ownerAddr, await bn254SigScheme.getAddress());
    subscriptionRegistry = await new SubscriptionRegistry__factory(owner).deploy(
      ownerAddr,
      await bn254SigScheme.getAddress(),
      await router.getAddress(),
    );

    // Router contract configuration
    await router.connect(owner).permitDestinationChainId(DST_CHAIN_ID);
    await router.connect(owner).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());
  });
});
