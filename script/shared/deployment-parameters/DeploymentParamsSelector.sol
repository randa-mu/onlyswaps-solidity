// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import "./DeploymentParamsAnvil.sol";
import "./DeploymentParamsAvalanche.sol";
import "./DeploymentParamsBase.sol";

library DeploymentParamsSelector {
    function getDeploymentParams(uint256 chainId) internal pure returns (DeploymentParameters memory) {
        // Local Anvil deployment
        if (chainId == 31_337) return DeploymentParamsAnvil.getDeploymentParams();
        if (chainId == 43_113 || chainId == 43_114) return DeploymentParamsAvalanche.getDeploymentParams();
        if (chainId == 84_532) return DeploymentParamsBase.getDeploymentParams();

        // For custom anvil chain ids used in demo scripts
        if (chainId > 0) return DeploymentParamsAnvil.getDeploymentParams();

        revert("Unsupported chain");
    }
}
