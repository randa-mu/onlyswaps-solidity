// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ISignatureScheme} from "./interfaces/ISignatureScheme.sol";
import {ErrorsLib} from "./libraries/ErrorsLib.sol";
import {BLS} from "bls-solidity/BLS.sol";

/// @title ScheduledUpgradeable
/// @author Randamu
/// @notice Abstract contract for scheduling, cancelling, and executing contract upgrades.
/// @dev Handles BLS (BN254) signature verification for scheduling and cancelling upgrades.
abstract contract ScheduledUpgradeable is Initializable, UUPSUpgradeable {
    /// @notice Unique nonce for each message to prevent replay attacks
    uint256 public currentNonce;

    /// @notice Address of the scheduled implementation upgrade
    address public scheduledImplementation;

    /// @notice Calldata for the scheduled implementation upgrade
    bytes internal scheduledImplementationCalldata;

    /// @notice Timestamp for the scheduled implementation upgrade
    uint256 public scheduledTimestampForUpgrade;

    /// @notice Minimum delay for upgrade operations
    uint256 public minimumContractUpgradeDelay;

    /// @notice BLS validator used for validating admin threshold signatures for stopping timed upgrades
    ISignatureScheme public contractUpgradeBlsValidator;

    // ---------------------- Events ----------------------
    /// @notice Emitted when the minimum contract upgrade delay is updated
    /// @param newDelay The new minimum delay for upgrade operations
    event MinimumContractUpgradeDelayUpdated(uint256 newDelay);
    /// @notice Emitted when a contract upgrade is scheduled
    /// @param newImplementation The address of the new implementation contract
    /// @param executeAfter The timestamp after which the upgrade can be executed
    event UpgradeScheduled(address indexed newImplementation, uint256 executeAfter);

    /// @notice Emitted when a scheduled upgrade is cancelled
    /// @param cancelledImplementation The address of the cancelled implementation contract
    event UpgradeCancelled(address indexed cancelledImplementation);

    /// @notice Emitted when a scheduled upgrade is executed
    /// @param newImplementation The address of the new implementation contract
    event UpgradeExecuted(address indexed newImplementation);

    /// @notice Emitted when the BLS validator contract is updated
    /// @param contractUpgradeBlsValidator The new BLS validator contract address
    event ContractUpgradeBLSValidatorUpdated(address indexed contractUpgradeBlsValidator);

    // ---------------------- Initializer ----------------------

    /// @notice Initializes upgrade scheduling logic.
    /// @param _contractUpgradeBlsValidator Address of the BLS validator contract
    /// @param _minimumContractUpgradeDelay Minimum delay for upgrades in seconds
    function __ScheduledUpgradeable_init(address _contractUpgradeBlsValidator, uint256 _minimumContractUpgradeDelay)
        internal
        onlyInitializing
    {
        require(_contractUpgradeBlsValidator != address(0), ErrorsLib.ZeroAddress());
        require(_minimumContractUpgradeDelay >= 2 days, ErrorsLib.UpgradeDelayTooShort());

        contractUpgradeBlsValidator = ISignatureScheme(_contractUpgradeBlsValidator);
        minimumContractUpgradeDelay = _minimumContractUpgradeDelay;
    }

    // ---------------------- External Functions ----------------------

    function scheduleUpgrade(
        address newImplementation,
        bytes calldata upgradeCalldata,
        uint256 upgradeTime,
        bytes calldata signature
    ) public virtual {
        require(newImplementation != address(0), ErrorsLib.ZeroAddress());
        require(
            upgradeTime >= block.timestamp + minimumContractUpgradeDelay,
            ErrorsLib.UpgradeTimeMustRespectDelay(minimumContractUpgradeDelay)
        );

        string memory action = "schedule";
        uint256 nonce = ++currentNonce;
        (, bytes memory messageAsG1Bytes,) =
            contractUpgradeParamsToBytes(action, newImplementation, upgradeCalldata, upgradeTime, nonce);

        require(
            contractUpgradeBlsValidator.verifySignature(
                messageAsG1Bytes, signature, contractUpgradeBlsValidator.getPublicKeyBytes()
            ),
            ErrorsLib.BLSSignatureVerificationFailed()
        );

        scheduledImplementation = newImplementation;
        scheduledTimestampForUpgrade = upgradeTime;
        scheduledImplementationCalldata = upgradeCalldata;

        emit UpgradeScheduled(newImplementation, upgradeTime);
    }

    function cancelUpgrade(bytes calldata signature) public virtual {
        require(
            block.timestamp < scheduledTimestampForUpgrade,
            ErrorsLib.TooLateToCancelUpgrade(scheduledTimestampForUpgrade)
        );

        string memory action = "cancel";
        uint256 nonce = ++currentNonce;
        (, bytes memory messageAsG1Bytes,) = contractUpgradeParamsToBytes(
            action, scheduledImplementation, scheduledImplementationCalldata, scheduledTimestampForUpgrade, nonce
        );

        require(
            contractUpgradeBlsValidator.verifySignature(
                messageAsG1Bytes, signature, contractUpgradeBlsValidator.getPublicKeyBytes()
            ),
            ErrorsLib.BLSSignatureVerificationFailed()
        );

        address cancelledImplementation = scheduledImplementation;

        scheduledImplementation = address(0);
        scheduledTimestampForUpgrade = 0;
        scheduledImplementationCalldata = "";

        emit UpgradeCancelled(cancelledImplementation);
    }

    function executeUpgrade() public virtual {
        require(scheduledImplementation != address(0), ErrorsLib.NoUpgradePending());
        require(
            block.timestamp >= scheduledTimestampForUpgrade, ErrorsLib.UpgradeTooEarly(scheduledTimestampForUpgrade)
        );

        address impl = scheduledImplementation;
        bytes memory callData = scheduledImplementationCalldata;

        scheduledImplementation = address(0);
        scheduledTimestampForUpgrade = 0;
        scheduledImplementationCalldata = "";

        (bool success, bytes memory ret) =
            address(this).call(abi.encodeWithSelector(this.upgradeToAndCall.selector, impl, callData));

        if (!success) {
            if (ret.length > 0) {
                assembly {
                    let size := mload(ret)
                    revert(add(ret, 32), size)
                }
            }
            revert ErrorsLib.UpgradeFailed();
        }

        emit UpgradeExecuted(impl);
    }

    // ---------------------- View Functions ----------------------

    function contractUpgradeParamsToBytes(
        string memory action,
        address newImplementation,
        bytes memory upgradeCalldata,
        uint256 upgradeTime,
        uint256 nonce
    ) public view virtual returns (bytes memory, bytes memory, BLS.PointG1 memory) {
        bytes memory message = abi.encode(action, newImplementation, upgradeCalldata, upgradeTime, nonce);
        (uint256 x, uint256 y) = contractUpgradeBlsValidator.hashToPoint(message);
        BLS.PointG1 memory messageAsG1Point = BLS.PointG1({x: x, y: y});
        bytes memory messageAsG1Bytes = abi.encode(messageAsG1Point.x, messageAsG1Point.y);
        return (message, messageAsG1Bytes, messageAsG1Point);
    }

    // ---------------------- Internal Functions ----------------------

    /// @dev Required by UUPS to restrict upgrades.
    function _authorizeUpgrade(address) internal view virtual override {
        require(msg.sender == address(this), ErrorsLib.UpgradeMustGoThroughExecuteUpgrade());
    }

    // ---------------------- Admin Functions ----------------------

    function setContractUpgradeBlsValidator(address _contractUpgradeBlsValidator) public virtual {
        require(_contractUpgradeBlsValidator != address(0), ErrorsLib.ZeroAddress());
        contractUpgradeBlsValidator = ISignatureScheme(_contractUpgradeBlsValidator);
        emit ContractUpgradeBLSValidatorUpdated(address(contractUpgradeBlsValidator));
    }

    function setMinimumContractUpgradeDelay(uint256 _minimumContractUpgradeDelay) public virtual {
        require(_minimumContractUpgradeDelay > 2 days, ErrorsLib.UpgradeDelayTooShort());
        minimumContractUpgradeDelay = _minimumContractUpgradeDelay;
        emit MinimumContractUpgradeDelayUpdated(minimumContractUpgradeDelay);
    }
}
