import { HardhatUserConfig } from "hardhat/config";

// foundry support
import "@nomicfoundation/hardhat-foundry";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.30",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 10,
      }
    }
  },
  gasReporter: {
    enabled: false,
  },  
};

export default config;
