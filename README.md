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

### BN254SignatureScheme

`BN254SignatureScheme` is a contract for BLS signature verification on the BN254 curve. It is used to verify off-chain signatures for swap requests and contract upgrades. The contract supports domain separation via a unique DST (Domain Separation Tag) for each use case (e.g., bridge swaps or upgrades), ensuring signatures cannot be replayed across domains.

- The DST is set in the constructor and includes the chain ID and contract type (e.g., "bridge" or "upgrade").
- The contract exposes functions for verifying BLS signatures and retrieving validator keys.


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

## Demo

### OnlySwaps

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

## Licensing

This library is licensed under the MIT License which can be accessed [here](LICENSE).

## Contributing

Contributions are welcome! If you find a bug, have a feature request, or want to improve the code, feel free to open an issue or submit a pull request.
