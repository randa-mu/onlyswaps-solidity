## onlysubs-solidity

## Overview

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
open coverage/index.html
# or on Linux
xdg-open coverage/index.html
```


#### Formatting

To correctly format the Solidity and JS code, run the following command:

```bash
npm run lint:fix
```

## Demo

### OnlySwaps

The OnlySwaps demo script shows how to deploy and interact with contracts across two local Anvil chains with custom chain IDs.

#### Steps

1. **Start two Anvil chains in separate terminal windows:**

```bash
anvil --port 8545 --chain-id 31337
```

```bash
anvil --port 8546 --chain-id 31338
```

2. **Run the demo script:**

```bash
npx ts-node demo/onlyswaps-e2e-demo.ts
```

The script will deploy contracts on both chains, perform a cross-chain token swap, and display logs including chain IDs, transfer parameters, and balances.


## Licensing

This library is licensed under the MIT License which can be accessed [here](LICENSE).

## Contributing

Contributions are welcome! If you find a bug, have a feature request, or want to improve the code, feel free to open an issue or submit a pull request.
