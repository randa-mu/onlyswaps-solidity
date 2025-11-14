import {
  Router,
  Router__factory,
  HookExecutor,
  MockRouterV2__factory,
  ERC20Token,
  ERC20Token__factory,
  BLSBN254SignatureScheme,
  BLSBN254SignatureScheme__factory,
  UUPSProxy__factory,
  Permit2Relayer,
  Permit2Relayer__factory,
  Permit2__factory,
  HookExecutor__factory,
  MockAaveV3,
  MockAaveV3__factory,
  Permit2,
} from "../../typechain-types";
import { EMPTY_HOOKS, extractSingleLog } from "./utils/utils";
import { bn254 } from "@kevincharm/noble-bn254-drand";
import { randomBytes } from "@noble/hashes/utils";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { AbiCoder, parseEther, keccak256, ZeroAddress, MaxUint256 } from "ethers";
import { ethers } from "hardhat";

const DST_CHAIN_ID = 137;

const VERIFICATION_FEE_BPS = 500;

describe("Hooks", function () {
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
  let permit2: Permit2;
  let permit2Relayer: Permit2Relayer;
  let hookExecutor: HookExecutor;
  let mockAaveV3: MockAaveV3;

  let privKeyBytes: Uint8Array;
  let ownerAddr: string, solverAddr: string, solverRefundAddr: string, userAddr: string, recipientAddr: string;

  const swapType = "swap-v1";
  const upgradeType = "upgrade-v1";

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
    // Deploy Permit2
    permit2 = await new Permit2__factory(owner).deploy();
    await permit2.waitForDeployment();
    // Deploy Permit2Relayer
    permit2Relayer = await new Permit2Relayer__factory(owner).deploy(await permit2.getAddress());
    await permit2Relayer.waitForDeployment();

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
    await router.connect(owner).setPermit2Relayer(await permit2Relayer.getAddress());
    await router.connect(owner).permitDestinationChainId(DST_CHAIN_ID);
    await router.connect(owner).setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());

    // Deploy HookExecutor
    hookExecutor = await new HookExecutor__factory(owner).deploy(await router.getAddress());
    await hookExecutor.waitForDeployment();
    await router.connect(owner).setHookExecutor(await hookExecutor.getAddress());

    // Deploy mock AaveV3 lending pool contract
    mockAaveV3 = await new MockAaveV3__factory(owner).deploy();
    await mockAaveV3.waitForDeployment();
  });

  describe("Create cross-chain swap request on source chain with permit and hooks embedded in (additional) witness data", function () {
    it("should make a swap request with valid Aave V3 post hooks and permit additional data", async () => {
      const amountIn = parseEther("10");
      const amountOut = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amountIn + solverFee;
      const permitNonce = 0;
      const permitDeadline = MaxUint256;

      const srcChainId = await router.getChainId();

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(await permit2.getAddress(), MaxUint256);

      // Create post hooks: approve + supply to Aave V3
      const postHooks = [
        {
          target: await dstToken.getAddress(),
          callData: dstToken.interface.encodeFunctionData("approve", [await mockAaveV3.getAddress(), amountOut]),
          gasLimit: 100000,
        },
        {
          target: await mockAaveV3.getAddress(),
          callData: mockAaveV3.interface.encodeFunctionData("supply", [
            await dstToken.getAddress(),
            amountOut,
            recipientAddr, // onBehalfOf recipient
            0,
          ]),
          gasLimit: 200000,
        },
      ];

      // Convert hooks to arrays for encoding
      const postHooksForEncoding = postHooks.map((hook) => [hook.target, hook.callData, hook.gasLimit]);
      const preHooksForEncoding = EMPTY_HOOKS.preHooks;

      // Generate Permit2 signature with witness data including hooks
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
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
          solverFee: solverFee.toString(),
          dstChainId: DST_CHAIN_ID,
          recipient: await hookExecutor.getAddress(), // recipient is hook executor for hooks execution
          additionalData: AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "bytes32"],
            [
              keccak256(AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [preHooksForEncoding])),
              keccak256(AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [postHooksForEncoding])),
            ],
          ),
        },
      };

      const signature = await user.signTypedData(permit2Domain, permit2Types, permit2Message);

      // Local verification
      const recovered = ethers.verifyTypedData(permit2Domain, permit2Types, permit2Message, signature);
      expect(recovered.toLowerCase()).to.equal(userAddr.toLowerCase());

      // On-chain verification and swap request with hooks
      const requestCrossChainSwapPermit2Params = {
        requester: userAddr,
        tokenIn: await srcToken.getAddress(),
        tokenOut: await dstToken.getAddress(),
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        solverFee: solverFee.toString(),
        dstChainId: DST_CHAIN_ID,
        recipient: await hookExecutor.getAddress(), // recipient is hook executor
        permitNonce: permitNonce,
        permitDeadline: permitDeadline,
        signature: signature,
        preHooks: EMPTY_HOOKS.preHooks,
        postHooks: postHooks,
      };

      // Make swap request with hooks and permit
      const swapRequestTx = await router.requestCrossChainSwapPermit2(requestCrossChainSwapPermit2Params);
      await expect(swapRequestTx).to.emit(router, "SwapRequested");

      // Check that source tokens were transferred to router
      expect(await srcToken.balanceOf(await router.getAddress())).to.equal(amountToMint);
      expect(await srcToken.balanceOf(userAddr)).to.equal(0);

      // Extract request ID from the SwapRequested event
      const receipt = await swapRequestTx.wait();
      const [requestId] = extractSingleLog(
        router.interface,
        receipt!,
        await router.getAddress(),
        router.interface.getEvent("SwapRequested"),
      );

      // Verify that the request includes the hooks in additional data
      const swapRequestReceipt = await router.getSwapRequestReceipt(requestId);
      const [, , , , , fulfilled] = swapRequestReceipt;
      expect(fulfilled).to.be.false; // Not fulfilled yet

      /// get swap request data and check hooks
      const [
        senderFromParams,
        recipientFromParams,
        tokenInFromParams,
        tokenOutFromParams,
        amountOutFromParams,
        srcChainIdFromParams,
        dstChainIdFromParams,
        verificationFeeFromParams,
        solverFeeFromParams,
        nonceFromParams,
        executedFromParams,
        requestedAtFromParams,
        preHooksFromParams,
        postHooksFromParams,
      ] = await router.getSwapRequestParameters(requestId);

      // Validate all parameters
      expect(senderFromParams).to.equal(userAddr);
      expect(recipientFromParams).to.equal(await hookExecutor.getAddress());
      expect(tokenInFromParams).to.equal(await srcToken.getAddress());
      expect(tokenOutFromParams).to.equal(await dstToken.getAddress());
      expect(amountOutFromParams).to.equal(amountOut);
      expect(srcChainIdFromParams).to.equal(srcChainId);
      expect(dstChainIdFromParams).to.equal(DST_CHAIN_ID);
      expect(executedFromParams).to.be.false;
      expect(solverFeeFromParams).to.equal(solverFee);
      expect(nonceFromParams).to.equal(1); // First swap request gets nonce 1
      expect(requestedAtFromParams).to.be.greaterThan(0);
      expect(verificationFeeFromParams).to.be.greaterThan(0);
      expect(verificationFeeFromParams).to.be.lessThan(amountOutFromParams);

      // Validate hooks
      expect(preHooksFromParams).to.deep.equal(EMPTY_HOOKS.preHooks);
      expect(postHooksFromParams.length).to.equal(postHooks.length);
      for (let i = 0; i < postHooks.length; i++) {
        expect(postHooksFromParams[i][0]).to.equal(postHooks[i].target);
        expect(postHooksFromParams[i][1]).to.equal(postHooks[i].callData);
        expect(postHooksFromParams[i][2]).to.equal(postHooks[i].gasLimit);
      }
    });
  });

  describe("Post-Hook execution in relayTokens", function () {
    it("should relay tokens with Aave V3 post hooks and store a receipt", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 1;

      // Check recipient balance before transfer
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

      // Mint tokens for solver
      await dstToken.mint(solverAddr, amount);

      // Approve Router to spend solver's tokens
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

      // Create post hooks: approve + supply to Aave V3
      const postHooks = [
        {
          target: await dstToken.getAddress(),
          callData: dstToken.interface.encodeFunctionData("approve", [await mockAaveV3.getAddress(), amount]),
          gasLimit: 100000,
        },
        {
          target: await mockAaveV3.getAddress(),
          callData: mockAaveV3.interface.encodeFunctionData("supply", [
            await dstToken.getAddress(),
            amount,
            recipientAddr, // onBehalfOf recipient
            0,
          ]),
          gasLimit: 200000,
        },
      ];

      // Convert hooks to arrays for encoding
      const postHooksForEncoding = postHooks.map((hook) => [hook.target, hook.callData, hook.gasLimit]);
      const preHooksForEncoding = EMPTY_HOOKS.preHooks;

      // Pre-compute valid requestId with post hooks
      const abiCoder = new AbiCoder();
      const preHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [preHooksForEncoding]),
      );
      const postHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [postHooksForEncoding]),
      );
      const requestId: string = keccak256(
        abiCoder.encode(
          [
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32",
          ],
          [
            userAddr,
            await hookExecutor.getAddress(), // recipient is hook executor for hooks execution
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            dstChainId,
            nonce,
            preHooksHash,
            postHooksHash,
          ],
        ),
      );

      // Relay tokens with post hooks
      const relayTx = await router.connect(solver).relayTokens(
        solverRefundAddr,
        requestId,
        userAddr,
        await hookExecutor.getAddress(), // recipient is hook executor
        await srcToken.getAddress(),
        await dstToken.getAddress(),
        amount,
        srcChainId,
        nonce,
        EMPTY_HOOKS.preHooks,
        postHooks,
      );

      // Verify events emitted
      await expect(relayTx).to.emit(router, "SwapRequestFulfilled");
      await expect(relayTx).to.emit(dstToken, "Approval"); // Token approval to Aave
      await expect(relayTx).to.emit(mockAaveV3, "Supplied"); // Aave supply

      // Check Aave v3 contract received the tokens
      expect(await dstToken.balanceOf(await mockAaveV3.getAddress())).to.equal(amount);

      // Check receipt
      const swapRequestReceipt = await router.getSwapRequestReceipt(requestId);
      const [, , , , , fulfilled, solverFromReceipt, , amountOut] = swapRequestReceipt;

      expect(fulfilled).to.be.true;
      expect(amountOut).to.equal(amount);
      expect(solverFromReceipt).to.equal(solverRefundAddr);
      expect(solverAddr).to.not.equal(solverRefundAddr);

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);

      // Try to relay again - should fail
      await expect(
        router
          .connect(user)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            await hookExecutor.getAddress(),
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
            EMPTY_HOOKS.preHooks,
            postHooks,
          ),
      ).to.revertedWithCustomError(router, "AlreadyFulfilled()");

      expect((await router.getFulfilledTransfers()).length).to.be.equal(1);
    });

    it("should relay tokens with multiple Aave V3 post hooks in correct order", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 2; // Different nonce for unique request ID

      // Mint tokens for solver
      await dstToken.mint(solverAddr, amount);
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

      // Create multiple post hooks: partial approve + supply, then remaining approve + supply
      const postHooks = [
        {
          target: await dstToken.getAddress(),
          callData: dstToken.interface.encodeFunctionData("approve", [await mockAaveV3.getAddress(), parseEther("6")]),
          gasLimit: 100000,
        },
        {
          target: await mockAaveV3.getAddress(),
          callData: mockAaveV3.interface.encodeFunctionData("supply", [
            await dstToken.getAddress(),
            parseEther("6"),
            recipientAddr,
            0,
          ]),
          gasLimit: 200000,
        },
        {
          target: await dstToken.getAddress(),
          callData: dstToken.interface.encodeFunctionData("approve", [await mockAaveV3.getAddress(), parseEther("4")]),
          gasLimit: 100000,
        },
        {
          target: await mockAaveV3.getAddress(),
          callData: mockAaveV3.interface.encodeFunctionData("supply", [
            await dstToken.getAddress(),
            parseEther("4"),
            recipientAddr,
            0,
          ]),
          gasLimit: 200000,
        },
      ];

      // Convert hooks to arrays for encoding
      const postHooksForEncoding = postHooks.map((hook) => [hook.target, hook.callData, hook.gasLimit]);
      const preHooksForEncoding = EMPTY_HOOKS.preHooks;

      // Pre-compute valid requestId
      const abiCoder = new AbiCoder();
      const preHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [preHooksForEncoding]),
      );
      const postHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [postHooksForEncoding]),
      );
      const requestId: string = keccak256(
        abiCoder.encode(
          [
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32",
          ],
          [
            userAddr,
            await hookExecutor.getAddress(),
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            dstChainId,
            nonce,
            preHooksHash,
            postHooksHash,
          ],
        ),
      );

      const relayTx = await router
        .connect(solver)
        .relayTokens(
          solverRefundAddr,
          requestId,
          userAddr,
          await hookExecutor.getAddress(),
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          srcChainId,
          nonce,
          EMPTY_HOOKS.preHooks,
          postHooks,
        );

      // Should emit multiple events in order
      await expect(relayTx).to.emit(router, "SwapRequestFulfilled");
      await expect(relayTx).to.emit(dstToken, "Approval");
      await expect(relayTx).to.emit(mockAaveV3, "Supplied");

      // Check Aave v3 contract received the tokens
      expect(await dstToken.balanceOf(await mockAaveV3.getAddress())).to.equal(amount);

      // Check receipt
      const swapRequestReceipt = await router.getSwapRequestReceipt(requestId);
      const [, , , , , fulfilled, solverFromReceipt, , amountOut] = swapRequestReceipt;

      expect(fulfilled).to.be.true;
      expect(amountOut).to.equal(amount);
      expect(solverFromReceipt).to.equal(solverRefundAddr);

      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(true);
    });

    it("should revert if Aave V3 post hook execution fails during relay", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 4;

      // Mint tokens for solver
      await dstToken.mint(solverAddr, amount);
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

      // Create failing post hook (invalid function call to Aave)
      const postHooks = [
        {
          target: await dstToken.getAddress(),
          callData: dstToken.interface.encodeFunctionData("approve", [await mockAaveV3.getAddress(), amount]),
          gasLimit: 100000,
        },
        {
          target: await mockAaveV3.getAddress(),
          callData: "0x12345678", // Invalid calldata
          gasLimit: 200000,
        },
      ];

      // Convert hooks to arrays for encoding
      const postHooksForEncoding = postHooks.map((hook) => [hook.target, hook.callData, hook.gasLimit]);
      const preHooksForEncoding = EMPTY_HOOKS.preHooks;

      // Pre-compute valid requestId
      const abiCoder = new AbiCoder();
      const preHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [preHooksForEncoding]),
      );
      const postHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [postHooksForEncoding]),
      );
      const requestId: string = keccak256(
        abiCoder.encode(
          [
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32",
          ],
          [
            userAddr,
            await hookExecutor.getAddress(),
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            dstChainId,
            nonce,
            preHooksHash,
            postHooksHash,
          ],
        ),
      );

      // Should revert due to failing hook
      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            await hookExecutor.getAddress(),
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
            EMPTY_HOOKS.preHooks,
            postHooks,
          ),
      ).to.be.reverted;

      // Request should not be fulfilled
      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(false);
    });

    it("should revert if post hook execution fails during relay", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 5; // Different nonce for unique request ID

      // Mint tokens for solver
      await dstToken.mint(solverAddr, amount);
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

      // Create failing post hook - try to call a function that doesn't exist on the token contract
      const postHooks = [
        {
          target: await dstToken.getAddress(),
          callData: dstToken.interface.encodeFunctionData("approve", [await mockAaveV3.getAddress(), amount]),
          gasLimit: 100000,
        },
        {
          target: await dstToken.getAddress(),
          callData: "0xdeadbeef", // Invalid function selector that doesn't exist
          gasLimit: 200000,
        },
      ];

      // Convert hooks to arrays for encoding
      const postHooksForEncoding = postHooks.map((hook) => [hook.target, hook.callData, hook.gasLimit]);
      const preHooksForEncoding = EMPTY_HOOKS.preHooks;

      // Pre-compute valid requestId
      const abiCoder = new AbiCoder();
      const preHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [preHooksForEncoding]),
      );
      const postHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [postHooksForEncoding]),
      );
      const requestId: string = keccak256(
        abiCoder.encode(
          [
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32",
          ],
          [
            userAddr,
            await hookExecutor.getAddress(), // recipient is hook executor
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            dstChainId,
            nonce,
            preHooksHash,
            postHooksHash,
          ],
        ),
      );

      // Should revert due to failing hook execution
      await expect(
        router
          .connect(solver)
          .relayTokens(
            solverRefundAddr,
            requestId,
            userAddr,
            await hookExecutor.getAddress(),
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            nonce,
            EMPTY_HOOKS.preHooks,
            postHooks,
          ),
      ).to.be.reverted;

      // Verify that the request was not fulfilled
      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(false);
      expect((await router.getFulfilledTransfers()).length).to.be.equal(0);

      // Verify that tokens were not transferred to hook executor
      expect(await dstToken.balanceOf(await hookExecutor.getAddress())).to.equal(0);

      // Verify that the swap request receipt shows the request as unfulfilled
      const swapRequestReceipt = await router.getSwapRequestReceipt(requestId);
      const [, , , , , fulfilled] = swapRequestReceipt;
      expect(fulfilled).to.be.false;
    });

    it("should not execute post hooks with ETH value during relay", async () => {
      const ethValue = parseEther("0.1");
      // Sending ETH to hook executor for hooks that require value transfers should revert
      // Hook executor does not accept ETH
      await expect(
        owner.sendTransaction({
          to: await hookExecutor.getAddress(),
          value: ethValue,
        }),
      ).to.be.reverted;
    });

    it("should revert if hook executor is not set in router", async () => {
      const amount = parseEther("10");
      const srcChainId = 1;
      const dstChainId = 31337;
      const nonce = 6; // Different nonce for unique request ID

      // deploy fresh router and do not set hook executor
      const mockRouterV2Implementation = await new MockRouterV2__factory(owner).deploy();
      await mockRouterV2Implementation.waitForDeployment();

      const UUPSProxy = new ethers.ContractFactory(UUPSProxy__factory.abi, UUPSProxy__factory.bytecode, owner);
      const mockRouterV2Proxy = await UUPSProxy.deploy(
        await mockRouterV2Implementation.getAddress(),
        MockRouterV2__factory.createInterface().encodeFunctionData("initialize", [
          ownerAddr,
          await swapBn254SigScheme.getAddress(),
          await upgradeBn254SigScheme.getAddress(),
          VERIFICATION_FEE_BPS,
        ]),
      );
      await mockRouterV2Proxy.waitForDeployment();

      // Attach Router interface to proxy address
      const routerAttached = Router__factory.connect(await mockRouterV2Proxy.getAddress(), owner);
      router = routerAttached;

      // Router contract configuration
      await router.connect(owner).setPermit2Relayer(await permit2Relayer.getAddress());
      await router.connect(owner).permitDestinationChainId(DST_CHAIN_ID);
      await router
        .connect(owner)
        .setTokenMapping(DST_CHAIN_ID, await dstToken.getAddress(), await srcToken.getAddress());

      // Mint tokens for solver
      await dstToken.mint(solverAddr, amount);
      await dstToken.connect(solver).approve(await router.getAddress(), amount);

      // Create post hooks: approve + supply to Aave V3
      const postHooks = [
        {
          target: await dstToken.getAddress(),
          callData: dstToken.interface.encodeFunctionData("approve", [await mockAaveV3.getAddress(), amount]),
          gasLimit: 100000,
        },
        {
          target: await mockAaveV3.getAddress(),
          callData: mockAaveV3.interface.encodeFunctionData("supply", [
            await dstToken.getAddress(),
            amount,
            recipientAddr,
            0,
          ]),
          gasLimit: 200000,
        },
      ];

      // Convert hooks to arrays for encoding
      const postHooksForEncoding = postHooks.map((hook) => [hook.target, hook.callData, hook.gasLimit]);
      const preHooksForEncoding = EMPTY_HOOKS.preHooks;

      // Pre-compute valid requestId
      const abiCoder = new AbiCoder();
      const preHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [preHooksForEncoding]),
      );
      const postHooksHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(["tuple(address,bytes,uint256)[]"], [postHooksForEncoding]),
      );
      const requestId: string = keccak256(
        abiCoder.encode(
          [
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32",
          ],
          [
            userAddr,
            ZeroAddress, // recipient set to zero address since hook executor is not set
            await srcToken.getAddress(),
            await dstToken.getAddress(),
            amount,
            srcChainId,
            dstChainId,
            nonce,
            preHooksHash,
            postHooksHash,
          ],
        ),
      );

      // Should revert because hook executor is not set (zero address)
      await expect(
        router.connect(solver).relayTokens(
          solverRefundAddr,
          requestId,
          userAddr,
          ZeroAddress, // recipient is zero address
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          srcChainId,
          nonce,
          EMPTY_HOOKS.preHooks,
          postHooks, // Has post hooks but no hook executor to execute them
        ),
        // setting recipient to zero address reverts before reaching HookExecutor check in _executeHooks
        // so we expect InvalidTokenOrRecipient error
      ).to.be.revertedWithCustomError(router, "InvalidTokenOrRecipient");

      // Verify that the request was not fulfilled
      expect((await router.getFulfilledTransfers()).includes(requestId)).to.be.equal(false);

      // Verify that no tokens were transferred
      expect(await dstToken.balanceOf(ZeroAddress)).to.equal(0);
      expect(await dstToken.balanceOf(recipientAddr)).to.equal(0);

      // Verify that the swap request receipt shows the request as unfulfilled
      const swapRequestReceipt = await router.getSwapRequestReceipt(requestId);
      const [, , , , , fulfilled] = swapRequestReceipt;
      expect(fulfilled).to.be.false;

      // Reset hook executor for subsequent tests
      await router.connect(owner).setHookExecutor(await hookExecutor.getAddress());
    });
  });

  describe("Rebalance solver", function () {
    it("should rebalance solver and verify hooks are deleted after request fulfilled", async () => {
      // Create token swap request on source chain with hooks
      const amount = parseEther("10");
      const solverFee = parseEther("1");
      const amountToMint = amount + solverFee;

      await srcToken.mint(userAddr, amountToMint);
      await srcToken.connect(user).approve(router.getAddress(), amountToMint);

      // Check initial allowance from hook executor to router is zero
      expect(await srcToken.allowance(await hookExecutor.getAddress(), await router.getAddress())).to.equal(0);
      // Check initial allowance from hook executor to user address is zero
      expect(await srcToken.allowance(await hookExecutor.getAddress(), userAddr)).to.equal(0);

      // Create pre and post hooks
      const preHooks = [
        {
          target: await srcToken.getAddress(),
          callData: srcToken.interface.encodeFunctionData("approve", [await router.getAddress(), amount]),
          gasLimit: 100000,
        },
      ];

      const postHooks = [
        {
          target: await dstToken.getAddress(),
          callData: dstToken.interface.encodeFunctionData("approve", [recipientAddr, amount]),
          gasLimit: 100000,
        },
      ];

      const tx = await router
        .connect(user)
        .requestCrossChainSwapWithHooks(
          await srcToken.getAddress(),
          await dstToken.getAddress(),
          amount,
          amount,
          solverFee,
          DST_CHAIN_ID,
          recipient.address,
          preHooks,
          postHooks,
        );

      let receipt = await tx.wait();
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

      // Verify that pre-hook was executed (approval)
      expect(await srcToken.allowance(await hookExecutor.getAddress(), await router.getAddress())).to.equal(amount);

      // Verify that post-hook was not executed yet / outside of relayTokens function
      expect(await srcToken.allowance(await hookExecutor.getAddress(), userAddr)).to.equal(0);

      // Verify hooks are stored before fulfillment
      const swapRequestParamsBefore = await router.getSwapRequestParameters(requestId);
      expect(swapRequestParamsBefore.preHooks.length).to.equal(1);
      expect(swapRequestParamsBefore.postHooks.length).to.equal(1);
      expect(swapRequestParamsBefore.preHooks[0].target).to.equal(await srcToken.getAddress());
      expect(swapRequestParamsBefore.postHooks[0].target).to.equal(await dstToken.getAddress());

      // Message signing
      const [, messageAsG1Bytes] = await router.swapRequestParametersToBytes(requestId, solver.address);
      const messageHex = messageAsG1Bytes.startsWith("0x") ? messageAsG1Bytes.slice(2) : messageAsG1Bytes;
      const M = bn254.G1.ProjectivePoint.fromHex(messageHex);
      const sigPoint = bn254.signShortSignature(M, privKeyBytes);
      const sigPointToAffine = sigPoint.toAffine();
      const sigBytes = AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256"],
        [sigPointToAffine.x, sigPointToAffine.y],
      );

      const before = await srcToken.balanceOf(solverAddr);

      expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(0);
      expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(1);

      // Rebalance with valid request ID
      await router.connect(owner).rebalanceSolver(solver.address, requestId, sigBytes);

      const after = await srcToken.balanceOf(solverAddr);
      const swapRequestParams = await router.getSwapRequestParameters(requestId);
      expect(after - before).to.equal(amount + swapRequestParams.solverFee - swapRequestParams.verificationFee);

      expect((await router.getFulfilledSolverRefunds()).length).to.be.equal(1);
      expect((await router.getUnfulfilledSolverRefunds()).length).to.be.equal(0);

      // Verify hooks are deleted after fulfillment
      const swapRequestParamsAfter = await router.getSwapRequestParameters(requestId);
      expect(swapRequestParamsAfter.preHooks.length).to.equal(0);
      expect(swapRequestParamsAfter.postHooks.length).to.equal(0);
    });
  });
});
