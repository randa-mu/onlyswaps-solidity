## onlysubs-solidity

## Overview

onlyswaps-solidity is a Solidity-based project enabling **cross-chain token bridging** using Foundry and Hardhat.
It includes a full test suite, demo scripts, and developer tooling for seamless local development.

## Tech Stack
- [Foundry](https://getfoundry.sh) — Solidity development & deployment
- [Hardhat](https://hardhat.org) — Testing & coverage reports
- [TypeScript](https://www.typescriptlang.org/) — Demo scripts
- [Anvil](https://book.getfoundry.sh/anvil/) — Local blockchain simulation

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

#### Code Coverage

To run foundry coverage:
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
npx hardhat compile
npx ts-node demo/onlyswap-e2e-demo.ts
```

The script will then deploy contracts on both chains, perform a cross-chain token swap, and display logs including chain IDs, transfer parameters, and balances.

Example output:

```bash
Anvil instances ready...
Configuring routers...
Recipient balance before swap request: 0.0 RUSD
Swap request created with requestId 0x2d0d7b3ffeaa37b249923f2bd6679462d018572c30760af2867f1a8c9db65793
Swap request parameters: {
  sender: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  recipient: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  token: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  amount: '10.0',
  srcChainId: 31337n,
  dstChainId: 31338n,
  swapFee: '0.05',
  solverFee: '0.95',
  nonce: 1n,
  executed: false
}
Recipient balance after relay: 10.0 RUSD
Solver balance before rebalance: 0.0 RUSD
Solver balance after rebalance: 10.95 RUSD
Anvil instances stopped.
```

## Licensing

This library is licensed under the MIT License which can be accessed [here](LICENSE).

## Contributing

Contributions are welcome! If you find a bug, have a feature request, or want to improve the code, feel free to open an issue or submit a pull request.
