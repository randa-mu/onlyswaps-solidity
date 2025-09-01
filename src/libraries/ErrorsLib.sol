// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

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
}
