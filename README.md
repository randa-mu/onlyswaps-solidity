# OnlySwaps

Solidity smart contracts for **cross-chain token swaps** with upgradeability and BLS signature verification.

## Architecture Overview

### Router

The `Router` contract is the central entry point for swap requests and contract upgrades. It manages cross-chain token swap requests, swap execution, and upgrade scheduling. The Router inherits from `ScheduledUpgradeable` to support secure, scheduled implementation contract upgrades based on ERC-1822, the [Universal Upgradeable Proxy Standard (UUPS)](https://docs.openzeppelin.com/contracts/4.x/api/proxy#UUPSUpgradeable).

### ScheduledUpgradeable

`ScheduledUpgradeable` is an abstract, upgradeable base contract that provides:
- Scheduling logic for contract upgrades, including time delays and BLS signature verification.
- Functions to schedule, execute, and cancel upgrades, ensuring upgrades are authorized and transparent.

Child contracts (like `Router`) inherit from `ScheduledUpgradeable` and can customize upgrade scheduling logic.

### BLSBN254SignatureScheme

`BLSBN254SignatureScheme` is a contract for BLS signature verification on the BN254 curve, used to verify off-chain signatures for swap requests and contract upgrades. The contract enforces domain separation using a unique Domain Separation Tag (DST) that includes the chain ID, contract type, and version (e.g., `"swap-v1"` or `"upgrade-v1"`), preventing signature replay across different domains or versions.

- The DST is set in the constructor and encodes both the contract type and version for each application.
- The contract exposes functions for verifying BLS signatures and retrieving validator keys.
- Example usage: `application` parameter in the constructor can be set to `"upgrade-v1"` for upgrade verification or `"swap-v1"` for swap requests.



## Usage

### Local Development

This repository comes with a comprehensive set of tests written in Solidity, which can be executed using [Foundry](https://getfoundry.sh/).

To install Foundry:

```sh
curl -L https://foundry.paradigm.xyz | bash
```

This will download foundryup. To start Foundry, run:

```sh
foundryup
```

To clone the repo:

```sh
git clone https://github.com/randa-mu/onlysubs-solidity
```

### Install dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

### Test

```bash
npm run test
```

### Deployment

For the deployment documentation, please see the deployment [guide here](./script/onlyswaps/README.md).


#### Code Coverage

The smart contract tests are written primarily using **[Hardhat](https://hardhat.org/)**.  

To generate a code coverage report, run:

```bash
npx hardhat coverage
```

After running coverage, you can optionally open the generated report to see detailed info:
```bash
open coverage/index.html # macOS
xdg-open coverage/index.html # Linux
```


#### Formatting

To correctly format the Solidity and JS code, run the following command:

```bash
npm run lint:fix
```


## Running the Demo

The OnlySwaps [demo script](demo/onlyswap-e2e-demo.ts) shows how to deploy and interact with contracts across two local Anvil chains with custom chain IDs. 

The script automatically spawns two Anvil blockchains at port 8545 (with chain id 31337) and 8546 (with chain id 31338).

To run the demo script, run the following command: 

```bash
npm run build
npx ts-node demo/onlyswap-e2e-demo.ts
```

The script will then deploy contracts on both chains, perform a cross-chain token swap, and display logs including chain IDs, transfer parameters, and balances.

Example output:

```bash
Anvil instances ready...
Configuring routers...
Recipient balance before swap request: 0.0 RUSD
Swap request created with requestId 0xc8e424bef2a726381716973580834e29713efb17b3af76c0f741bc7ff4a8cc4a
Swap request parameters: {
  sender: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  tokenIn: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
  tokenOut: '0x8464135c8F25Da09e49BC8782676a84730C318bC',
  amountOut: '9.5',
  srcChainId: 31337n,
  dstChainId: 31338n,
  verificationFee: '0.5',
  solverFee: '1.0',
  nonce: 1n,
  executed: false
}
Recipient balance after relay: 9.5 RUSD
Solver balance before rebalance: 0.0 RUSD
Solver balance after rebalance: 10.5 RUSD
Anvil instances stopped.
```


## BLS Signature Verification Workflows

Several critical functions in the OnlySwaps contracts require BLS (BN254) signature verification to ensure secure, threshold-authorized actions. Each function expects a BLS signature over a specific message, which can be generated off-chain using the helper functions provided in the contracts. The message generated is already hashed to a point on G1 using the correct Domain Separation Tag (DST). Below is a description of each function, how BLS verification is used, and how to obtain the message to sign.


### Swap Request & Solver Rebalancing

#### `rebalanceSolver`
- **Purpose:** Compensates the solver on the source chain (including solver fees) after the solver has sent liquidity from their wallet to the recipient address on the destination chain to fulfill a swap request.
- **BLS Verification:** Requires a valid BLS signature from the swap request validator over the swap request parameters.
- **Message Construction:**  
  - **Helper function called:**  
    `swapRequestParametersToBytes(bytes32 requestId, address solver)`
  - **Returns:**  
    - `message`: raw message bytes  
    - `messageAsG1Bytes`: marshaled G1 bytes (used for signing)
  - **To sign:** Use `messageAsG1Bytes` as the message for BLS signing.


#### `setSwapRequestBlsValidator`
- **Purpose:** Updates the swap request BLS validator contract.
- **BLS Verification:** Requires a valid BLS signature from the current validator over the update parameters.
- **Message Construction:**  
  - **Helper function called:**  
    `swapRequestBlsValidatorUpdateParamsToBytes(address newValidator, uint256 nonce)`
  - **Returns:**  
    - `message`: raw message bytes  
    - `messageAsG1Bytes`: marshaled G1 bytes (used for signing)
  - **To sign:** Use `messageAsG1Bytes` for BLS signing.


### Contract Upgrade Scheduling & Management

#### `scheduleUpgrade`
- **Purpose:** Schedules a contract upgrade to a new implementation.
- **BLS Verification:** Requires a valid BLS signature from the contract upgrade validator over the upgrade parameters.
- **Message Construction:**  
  - **Helper function called:**  
    `contractUpgradeParamsToBytes(string action, address pendingImplementation, address newImplementation, bytes upgradeCalldata, uint256 upgradeTime, uint256 nonce)` with action = `schedule`.
  - **Returns:**  
    - `message`: raw message bytes  
    - `messageAsG1Bytes`: marshaled G1 bytes (used for signing)
  - **To sign:** Use `messageAsG1Bytes` for BLS signing, with `action` set to `"schedule"`.


#### `cancelUpgrade`
- **Purpose:** Cancels a previously scheduled contract upgrade.
- **BLS Verification:** Requires a valid BLS signature from the contract upgrade validator over the cancellation parameters.
- **Message Construction:**  
  - **Helper function called:**  
    `contractUpgradeParamsToBytes(string action, address pendingImplementation, address newImplementation, bytes upgradeCalldata, uint256 upgradeTime, uint256 nonce)` with action = `cancel`.
  - **Returns:**  
    - `message`: raw message bytes  
    - `messageAsG1Bytes`: marshaled G1 bytes (used for signing)
  - **To sign:** Use `messageAsG1Bytes` for BLS signing, with `action` set to `"cancel"`.

#### `setContractUpgradeBlsValidator`
- **Purpose:** Updates the contract upgrade BLS validator contract.
- **BLS Verification:** Requires a valid BLS signature from the current validator over the validator update parameters.
- **Message Construction:**  
  - **Helper function called:**  
    `blsValidatorUpdateParamsToBytes(address blsValidator, uint256 nonce)`
  - **Returns:**  
    - `message`: raw message bytes  
    - `messageAsG1Bytes`: marshaled G1 bytes (used for signing)
  - **To sign:** Use `messageAsG1Bytes` for BLS signing.

### How to Use Off-Chain

1. **Call the relevant helper function** on the contract to get the message bytes (`messageAsG1Bytes`) for signing.
2. **Sign the message** off-chain using your BLS key.
3. **Submit the signature** as part of the transaction to the contract function.

This design ensures that all critical actions (swap validation, upgrade scheduling/cancellation, validator updates) are authorized by a threshold of BLS signers, and the message format is always available on-chain for off-


## Licensing

This library is licensed under the MIT License which can be accessed [here](LICENSE).

## Contributing

Contributions are welcome! If you find a bug, have a feature request, or want to improve the code, feel free to open an issue or submit a pull request.
