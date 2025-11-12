// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8;

/// @dev A user-specified hook to be executed before or after an intent.
/// @param target The address of the contract to call for the hook.
/// @param callData The calldata to be sent to the target contract for the hook execution.
/// @param gasLimit The maximum gas allowed for the hook execution.
struct Hook {
    address target;
    bytes callData;
    uint256 gasLimit;
}

/// @notice Interface for executing an array of hooks.
interface IHookExecutor {
    /// @notice Executes the provided hooks.
    /// @param hooks The array of Hook structs to execute.
    function execute(Hook[] calldata hooks) external;

    /// @notice Sets the gas limit for exact call checks.
    /// @param gasForCallExactCheck_ The new gas limit value.
    function setGasForCallExactCheck(uint32 gasForCallExactCheck_) external;

    /// @notice Returns the current gas limit for exact call checks.
    /// @return The gas limit value.
    function gasForCallExactCheck() external view returns (uint32);
}
