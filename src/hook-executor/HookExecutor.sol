// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8;

import {IHookExecutor, Hook} from "../interfaces/IHookExecutor.sol";

import {CallWithExactGas} from "../libraries/CallWithExactGas.sol";

/// @dev A contract for executing user-specified hooks. It ensures that
/// user-specified calls are not executed from a privileged context, and that
/// reverts do not prevent Router and borrower matching from executing.
contract HookExecutor is IHookExecutor {
    using CallWithExactGas for bytes;

    /// @dev The address of the Router contract.
    address public immutable router;
    /// @notice Gas amount reserved for the exact EXTCODESIZE call and additional overhead
    ///         required by the `CallWithExactGas` library to safely execute calls.
    /// @dev This value should be carefully calibrated based on EVM gas costs to
    ///      prevent unexpected failures when making external calls with precise gas.
    ///      It can be updated by the Router contract if needed.
    uint32 public gasForCallExactCheck = 5_000;

    /// @dev Emitted after each hook is executed.
    event HookExecuted(address indexed target, bool success);
    /// @dev Emitted when execution of a hook fails and failure is not allowed.
    event HookExecutionFailed(address indexed target, bool success);
    /// @dev Emitted when the gasForCallExactCheck is set / updated.
    event GasForCallExactCheckSet(uint32 gasForCallExactCheck);

    /// @dev Error indicating that the contract was not called from the Router contract.
    error NotRouter();
    error HookExecutionFailedError(address target);

    /// @param router_ The address of the Router contract.
    constructor(address router_) {
        router = router_;
    }

    /// @dev Modifier that ensures that the `msg.sender` is the Router contract.
    modifier onlyRouter() {
        _onlyRouter();
        _;
    }

    /// @dev Executes the user specified hooks. Called only by the Router contract.
    /// Each hook is executed with the specified gas limit, and failure does not revert the entire transaction.
    /// Each hook is only executed before the specified expiry timestamp.
    /// @param hooks The hooks to execute.
    function execute(Hook[] calldata hooks) external onlyRouter {
        unchecked {
            for (uint256 i = 0; i < hooks.length; ++i) {
                Hook calldata hook = hooks[i];

                (bool success,) = hook.callData
                    ._callWithExactGasEvenIfTargetIsNoContract(hook.target, hook.gasLimit, gasForCallExactCheck);

                if (!success) {
                    // Revert if the call fails
                    revert HookExecutionFailedError(hook.target);
                } else {
                    emit HookExecuted(hook.target, success);
                }
            }
        }
    }

    /// @notice Updates the gas reserved for the exact EXTCODESIZE call and related checks
    ///         used internally when executing hooks.
    /// @dev Only callable by the Router contract.
    /// @param gasForCallExactCheck_ The new gas amount to reserve for the exact call check.
    ///        Should be calibrated according to current gas costs of the EXTCODESIZE opcode
    ///        and overhead from the CallWithExactGas library.
    function setGasForCallExactCheck(uint32 gasForCallExactCheck_) external onlyRouter {
        gasForCallExactCheck = gasForCallExactCheck_;
        emit GasForCallExactCheckSet(gasForCallExactCheck);
    }

    function _onlyRouter() internal view {
        require(msg.sender == router, NotRouter());
    }
}
