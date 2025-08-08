# Contract Deployment

The deployment [scripts](script) supports the deployment of single contracts or all contracts in a single run.

## Environment setup

Create a `.env` file. Then copy the `.env.example` to the `.env` file and set the applicable configuration variables for the testing / deployment environment.

Deployment is handled by solidity scripts in forge. The chain id or network being deployed to is dependent on the `RPC_URL` environment variable while the admin address set in the contracts is derived from the `PRIVATE_KEY` environment variable.

Other custom deployment parameters used for each chain id can be found in the [deployment-parameters directory](script/shared/deployment-parameters).


## Deploy All Contracts

To deploy all contracts in a single run, the `DeployAllContracts` script is used. This will run the deployments for all contracts specified in the script.
```sh
source .env

forge script script/onlyswaps/DeployAllContracts.s.sol:DeployAllContracts \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```

To enable contract verification on Etherscan (or equivalents), set your Etherscan API key in the `.env` file:
```bash
ETHERSCAN_API_KEY=<your_key>
```

When running a Forge script for deployment, add the following flags:
   - `--etherscan-api-key $ETHERSCAN_API_KEY` – Passes your API key.
   - `--verify` – Automatically verifies all contracts found in the deployment receipt.

Example:
   ```bash
   forge script script/onlyswaps/DeployAllContracts.s.sol:DeployAllContracts \
      --rpc-url $RPC_URL \
      --private-key $PRIVATE_KEY \
      --broadcast \
      --verify \
      --etherscan-api-key $ETHERSCAN_API_KEY
   ```

To verify an already deployed contract, e.g., to verify a deployed BN254SignatureScheme contract on the Base Sepolia testnet, we can use the following command:

```bash
forge verify-contract 0x778661105ca917fbCd81515C7814035f06c0be98 lib/onlysubs-solidity/src/signature-scheme/BN254SignatureScheme.sol:BN254SignatureScheme --chain-id 84532 --etherscan-api-key $BASE_SEPOLIA_ETHERSCAN_API_KEY
```

## Deploy a Single Contract

To deploy a single contract, the scripts within the `script/onlyswaps/single-deployment` directory are used, e.g., to deploy only the `BN254SignatureScheme.sol` contract contract, the command below is used:

```sh
source .env

forge script script/onlyswaps/single-deployment/DeployBN254SignatureScheme.s.sol:DeployBN254SignatureScheme \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```

To resolve dependencies between the contract deployments, a `.json` file named `<chain-id>.json` in the [script](script) folder is filled with contract addresses for the following contracts after they are deployed (either as single deployments or part of the single run deployment for all contracts):
* Router
* RUSD
* BN254SignatureScheme

For example, running the following command writes a JSON property `{"bn254SignatureVerifier": "0x7D020A4E3D8795581Ec06E0e57701dDCf7B19EDF"}` to the <chain-id>.json file:

```bash
forge script script/onlyswaps/single-deployment/DeployBN254SignatureScheme.s.sol:DeployBN254SignatureScheme \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast
```

Which is used by the [DeployRouter.sol](script/onlyswaps/single-deployment/DeployRouter.s.sol) deployment script when deploying [Router.sol](src/Router.sol).


## Filecoin deployment

For Filecoin Mainnet or Calibration Testnet, a common [deployment issue](https://github.com/filecoin-project/fevm-foundry-kit) that you may see is a failure due to gas. Simply pass in a higher gas limit to fix this (either via. a higher gas estimate multiplier using the `-g` flag or a fixed gas limit) e.g.,

```sh
-g 90000
```

## Deployment addresses

The file `contract-addresses.json` lists all official deployments of the contracts in this repository by `chain id`.

The deployment addresses file is generated with:

```sh
bash utils/generate-contract-addresses.sh > contract-addresses.json
```


## Post-deployment

### OnlySwaps Router contract configuration

The [ConfigureRouterScript](script/onlyswaps/utils/ConfigureRouterScript.s.sol) script enables the deployer or Router contract admin to configure the contract on any chain, i.e., set supported tokens and destination chain ids. It requires the following environment variables:
```bash 
ROUTER_SRC_ADDRESS=0xYourRouterSrcAddress
ERC20_SRC_ADDRESS=0xYourERC20SrcAddress
ERC20_DST_ADDRESS=0xYourERC20DstAddress
DST_CHAIN_ID=84532
```

And it can be ran using the following command:

```bash
forge script script/onlyswaps/utils/ConfigureRouterScript.s.sol:ConfigureRouterScript \
--rpc-url $RPC_URL \
--private-key $PRIVATE_KEY \
--broadcast
```