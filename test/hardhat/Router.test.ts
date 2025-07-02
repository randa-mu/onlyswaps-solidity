import {
  Router,
  Router__factory,
  ERC20Token,
  ERC20Token__factory,
  BN254SignatureScheme,
  BN254SignatureScheme__factory,
} from "../../typechain-types";
import { BlsBn254, kyberG1ToEvm, kyberG2ToEvm, toHex, kyberMarshalG1, kyberMarshalG2 } from "./crypto";
import { expand_message_xmd } from "@noble/curves/abstract/hash-to-curve";
import { keccak_256 } from "@noble/hashes/sha3";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import dotenv from "dotenv";
import { AbiCoder, MaxUint256, getBytes, hexlify, keccak256, parseEther, sha256, toUtf8Bytes } from "ethers";
import { ethers } from "hardhat";
import crypto from "node:crypto";

dotenv.config();

const blsKey = process.env.BLS_PRIVATE_KEY;
const DST_CHAIN_ID = 137;
const nonce = Math.floor(Math.random() * (100 - 1 + 1)) + 1;
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

    srcToken = await new ERC20Token__factory(owner).deploy("SrcToken", "STK", 18);
    dstToken = await new ERC20Token__factory(owner).deploy("DstToken", "DTK", 18);

    bn254SigScheme = await new BN254SignatureScheme__factory(owner).deploy(
      [default_pk.x.c0, default_pk.x.c1],
      [default_pk.y.c0, default_pk.y.c1],
    );

    // Deploy one router on src chain
    router = await new Router__factory(owner).deploy(ownerAddr, await bn254SigScheme.getAddress());
    // router configuration
    await router.connect(owner).allowDstChainId(DST_CHAIN_ID, true);
    await router.connect(owner).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());
  });

  it.only("should initiate a bridge request and emit message", async () => {
    const amount = parseEther("10");
    const fee = parseEther("1");
    const nonce = 1;
    const amountToMint = amount + fee;

    await srcToken.mint(userAddr, amountToMint);
    await srcToken.connect(user).approve(router.getAddress(), amountToMint);

    await expect(router.connect(user).bridge(await srcToken.getAddress(), amount, fee, DST_CHAIN_ID, recipientAddr, nonce))
      .to.emit(router, "MessageEmitted");
  });
});
