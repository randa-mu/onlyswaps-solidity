import {
  Router,
  Router__factory,
  MockRouterV2__factory,
  ERC20Token,
  ERC20Token__factory,
  BLSBN254SignatureScheme,
  BLSBN254SignatureScheme__factory,
  UUPSProxy__factory,
  Permit2Relayer,
  Permit2Relayer__factory,
  Permit2,
  Permit2__factory,
  src,
} from "../../typechain-types";
import { extractSingleLog } from "./utils/utils";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { AbiCoder, parseEther, keccak256, toUtf8Bytes, ZeroAddress, MaxUint256, TypedDataEncoder } from "ethers";
import { ethers } from "hardhat";

const DST_CHAIN_ID = 137;

const VERIFICATION_FEE_BPS = 500;

describe("Router", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let solver: SignerWithAddress;
  let solverRefundWallet: SignerWithAddress;
  let recipient: SignerWithAddress;

  let router: Router;
  let srcToken: ERC20Token;
  let dstToken: ERC20Token;
  let swapBn254SigScheme: BLSBN254SignatureScheme;
  let upgradeBn254SigScheme: BLSBN254SignatureScheme;
  let permit2Relayer: Permit2Relayer;
  let permit2: Permit2;

  let privKeyBytes: Uint8Array;
  let ownerAddr: string, solverAddr: string, solverRefundAddr: string, userAddr: string, recipientAddr: string;

  const swapType = "swap-v1";
  const upgradeType = "upgrade-v1";

  async function generateSignatureForBlsValidatorUpdate(
    router: Router,
    action: string,
    validatorAddress: string,
    currentNonce: number,
  ): Promise<string> {
    const [, messageAsG1Bytes] = await router.blsValidatorUpdateParamsToBytes(action, validatorAddress, currentNonce);
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
    [owner, user, solver, solverRefundWallet, recipient] = await ethers.getSigners();

    ownerAddr = await owner.getAddress();
    userAddr = await user.getAddress();
    recipientAddr = await recipient.getAddress();
    solverAddr = await solver.getAddress();
    solverRefundAddr = await solverRefundWallet.getAddress();

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
    // Deploy Permit2Relayer
    permit2Relayer = await new Permit2Relayer__factory(owner).deploy();
    await permit2Relayer.waitForDeployment();

    // Deploy Permit2
    permit2 = await new Permit2__factory(owner).deploy();
    await permit2.waitForDeployment();

    // Set Permit2 address in Permit2Relayer
    await permit2Relayer.connect(owner).setPermit2Address(await permit2.getAddress());

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
        await permit2Relayer.getAddress(),
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

  describe("Request cross chain swap with Permit2", function () {
    it.skip("should make a swap request with a valid Permit2 signature and emit swap requested event", async () => {
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();
      const currentNonce = await router.currentSwapRequestNonce();

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      // Generate requestId for the trade
      const swapRequestParameters = {
        sender: userAddr,
        recipient: recipientAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountOut: (await router.getVerificationFeeAmount(amount))[1],
        srcChainId: srcChainId,
        dstChainId: DST_CHAIN_ID,
        verificationFee: (await router.getVerificationFeeAmount(amount))[0],
        solverFee: solverFee,
        nonce: Number(currentNonce) + 1,
        executed: false,
        requestedAt: Math.floor(Date.now() / 1000),
      };

      const requestId = await router.getSwapRequestId(swapRequestParameters);
      console.log("Generated requestId:", requestId);

      // Generate Permit2 signature with witness data
      // Define Permit2 domain
const permit2Domain = {
  name: "Permit2",
  chainId: srcChainId,
  verifyingContract: await permit2.getAddress(),
};

// NOTE: The witness is passed on-chain as a pre-hashed bytes32,
// not as a nested struct. The type should match that.
const permit2Types = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "bytes32" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
};

// Compute WITNESS_TYPE_HASH the same way Solidity does
const WITNESS_TYPE_HASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "RelayerWitness(bytes32 requestId,address recipient,bytes additionalData)"
  )
);

// Compute the hashed witness struct
const witnessHash = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "address", "bytes32"],
    [
      WITNESS_TYPE_HASH,
      requestId,
      await router.getAddress(), // MUST match what we pass to relayTokensPermit2()
      ethers.keccak256("0x"), // additionalData
    ]
  )
);


     const permit2Message = {
  permitted: {
    token: await srcToken.getAddress(),
    amount: amountToMint.toString(),
  },
  spender: await permit2Relayer.getAddress(),
  nonce: permitNonce,
  deadline: permitDeadline,
  witness: witnessHash, // pre-hashed bytes32
};


      const onChainDomainSeparator = await permit2.DOMAIN_SEPARATOR();
const offChainDomainSeparator = ethers.TypedDataEncoder.hashDomain(permit2Domain);
console.log("On-chain DOMAIN_SEPARATOR:", onChainDomainSeparator);
console.log("Off-chain computed DOMAIN_SEPARATOR:", offChainDomainSeparator);


      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      // local verification
      try {
        const recovered = ethers.verifyTypedData(permit2Domain, permit2Types, permit2Message, signature);
        const digest = TypedDataEncoder.hash(permit2Domain, permit2Types, permit2Message);
        const recovered2 = ethers.recoverAddress(digest, signature);
        console.log(" verifyTypedData recovered:", recovered, "recoverAddress:", recovered2, "expected:", userAddr);

        if (recovered && recovered.toLowerCase() === userAddr.toLowerCase()) {
          console.log("Local recover successful for Permit2 signature, matches userAddr");
        }
      } catch (e) {
        console.error("Local recover failed for spender signature");
      }

      const sigBytes = ethers.getBytes(signature);
      const r = ethers.hexlify(sigBytes.slice(0, 32));
      const s = ethers.hexlify(sigBytes.slice(32, 64));
      const vRaw = sigBytes[64];
      console.log("signature parts r,s,v:", r, s, vRaw);

      await expect(
        router.requestCrossChainSwapPermit2(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          solverFee,
          DST_CHAIN_ID,
          userAddr,
          recipientAddr,
          permitNonce,
          permitDeadline,
          signature,
        ),
      ).to.emit(router, "SwapRequested");
    });

    it.skip("should fail to make a swap request with an invalid Permit2 signature", async () => {});

    it.skip("should fail to make a swap request when the requester address does not match the Permit2 signature", async () => {});

    it.skip("should fail to make a swap request when the permit has expired", async () => {});

    it.skip("should fail to make a swap request when the amount is zero", async () => {});

    it.skip("should fail to make a swap request when the recipient address is zero", async () => {});

    it.skip("should fail to make a swap request when the destination chain ID is not permitted", async () => {});

    it.skip("should fail to make a swap request when there is no token mapping for the destination chain ID and token", async () => {});

    it.only("should make a swap request with a valid Permit2 signature and emit swap requested event", async () => {
  const amount = parseEther("10");
  const solverFee = parseEther("1");
  const amountToMint = amount + solverFee;
  const permitNonce = 0;
  const permitDeadline = MaxUint256;

  const srcChainId = await router.getChainId();
  const currentNonce = await router.currentSwapRequestNonce();

  await srcToken.mint(userAddr, amountToMint);
  await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

  // Generate requestId for the trade
  const swapRequestParameters = {
    sender: userAddr,
    recipient: recipientAddr,
    tokenIn: await srcToken.getAddress(),
    tokenOut: await dstToken.getAddress(),
    amountOut: (await router.getVerificationFeeAmount(amount))[1],
    srcChainId: srcChainId,
    dstChainId: DST_CHAIN_ID,
    verificationFee: (await router.getVerificationFeeAmount(amount))[0],
    solverFee: solverFee,
    nonce: Number(currentNonce) + 1,
    executed: false,
    requestedAt: Math.floor(Date.now() / 1000),
  };

  const requestId = await router.getSwapRequestId(swapRequestParameters);
  console.log("Generated requestId:", requestId);

  // === Permit2 domain ===
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
      { name: "witness", type: "bytes32" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  };

  // Compute witness hash like on-chain
  const WITNESS_TYPE_HASH = ethers.keccak256(
    ethers.toUtf8Bytes("RelayerWitness(bytes32 requestId,address recipient,bytes additionalData)")
  );

  const additionalData = "0x"; // empty bytes
  const witnessHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "address", "bytes32"],
      [
        WITNESS_TYPE_HASH,
        requestId,
        await router.getAddress(), // router address (must match relayTokensPermit2 recipient)
        ethers.keccak256(additionalData),
      ]
    )
  );

  // Permit2 message
  const permit2Message = {
    permitted: {
      token: await srcToken.getAddress(),
      amount: amountToMint.toString(),
    },
    spender: await permit2Relayer.getAddress(),
    nonce: permitNonce,
    deadline: permitDeadline,
    witness: witnessHash,
  };

  // Sign typed data
  let signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

  // Fix v value if needed
  let sigBytes = ethers.getBytes(signature);
  let v = sigBytes[64];
  if (v < 27) v += 27;
  signature = ethers.hexlify(ethers.concat([sigBytes.slice(0, 64), Uint8Array.from([v])]));

  // Local verification
  const recovered = ethers.verifyTypedData(permit2Domain, permit2Types, permit2Message, signature);
  console.log("Recovered signer:", recovered, "Expected:", userAddr);
  expect(recovered.toLowerCase()).to.equal(userAddr.toLowerCase());

  // Call router
  await expect(
    router.requestCrossChainSwapPermit2(
      await srcToken.getAddress(),
      await dstToken.getAddress(),
      amount,
      solverFee,
      DST_CHAIN_ID,
      userAddr,
      recipientAddr,
      permitNonce,
      permitDeadline,
      signature
    )
  ).to.emit(router, "SwapRequested");
});

  });
});
