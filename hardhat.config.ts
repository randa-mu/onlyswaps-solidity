import { HardhatUserConfig } from "hardhat/config";

// foundry support
import "@nomicfoundation/hardhat-foundry";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: {
        enabled: true,
        runs: 2000,
      }
    }
  },
};

export default config;