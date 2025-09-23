// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

library ErrorsLib {
    /// @dev Custom errors
    error AlreadyFulfilled();
    error InvalidTokenOrRecipient();
    error ZeroAmount();
    error FeeTooLow();
    error TokenMappingAlreadyExists();
    error InvalidFeeBps();
    error TokenNotSupported();
    error UnauthorisedCaller();
    error NewFeeTooLow(uint256 newFee, uint256 currentFee);
    error DestinationChainIdNotSupported(uint256 dstChainId);
    error FeeBpsExceedsThreshold(uint256 maxFeeBps);
    error BLSSignatureVerificationFailed();
    error SwapRequestParametersMismatch();
    error SourceChainIdMismatch(uint256 swapRequestParamsSrcChainId, uint256 contractChainId);
    error SourceChainIdShouldBeDifferentFromDestination(uint256 srcChainId, uint256 dstChainId);
    error NoUpgradePending();
    error UpgradeTooEarly(uint256 upgradeTime);
    error TooLateToCancelUpgrade(uint256 upgradeTime);
    error ZeroAddress();
    error GrantRoleFailed();
    error UpgradeMustGoThroughExecuteUpgrade();
    error UpgradeFailed();
    error UpgradeDelayTooShort();
    error UpgradeTimeMustRespectDelay(uint256 earliestTime);
    error SameVersionUpgradeNotAllowed();
}
