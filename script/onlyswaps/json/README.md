## Contract Deployment Input JSON

To resolve dependencies between the contract deployments, a `.json` file named `<chain-id>.json` is created in this [script/randomness/json](.) folder and populated with contract addresses for the following contracts after they are deployed (either as single deployments or part of the single run deployment for all contracts) to ensure that other dependent scripts can fetch the addresses:
* RouterProxy
* RouterImplementation
* RUSD
* BN254SwapRequestSignatureScheme
* BN254ContractUpgradeSignatureScheme

For example, running the following command writes a JSON property `{"bn254SwapRequestSignatureSchemeAddress": "0x7D020A4E3D8795581Ec06E0e57701dDCf7B19EDF"}` to the `<chain-id>.json` file:

```bash
forge script script/onlyswaps/single-deployments/DeployBN254SwapRequestSignatureScheme.s.sol:DeployBN254SwapRequestSignatureScheme --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast --slow 
```