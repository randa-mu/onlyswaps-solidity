# OnlySwaps Security Audit Response

This document tracks the findings from the security audit and our responses, including references to relevant git commit hashes for fixes and improvements.

## Findings & Responses

**F1. [`SwapRequestParametersMismatch`](https://github.com/randa-mu/onlyswaps-solidity/blob/70d423aa6263bef123f409b6c38dbe5d63fb006a/src/libraries/ErrorsLib.sol#L18) is never used**  
*Response:*  
The custom error `SwapRequestParametersMismatch()` is now used in the `relayTokens()` function when validating the `requestId` derived from the swap request parameters using `keccak256(abi.encode(<swap-request-params>))`. See commit [`ab187063656f84894508b60d633c385c87fbda5f`](https://github.com/randa-mu/onlyswaps-solidity/pull/73/commits/ab187063656f84894508b60d633c385c87fbda5f) for details.

**F2. [`requestCrossChainSwap`](https://github.com/randa-mu/onlyswaps-solidity/blob/70d423aa6263bef123f409b6c38dbe5d63fb006a/src/Router.sol#L115) should check that recipient is not the Zero address similar to [here](https://github.com/randa-mu/onlyswaps-solidity/blob/70d423aa6263bef123f409b6c38dbe5d63fb006a/src/Router.sol#L183).**  
*Response:*  
A zero address check for the `recipient` parameter has been added to the `requestCrossChainSwap` function to prevent invalid recipient addresses. See commit [`b59f72d57a342c7d3cc2a3013d4bf855fba79c26`](https://github.com/randa-mu/onlyswaps-solidity/pull/70/commits/b59f72d57a342c7d3cc2a3013d4bf855fba79c26) for details.

**F3. [`requestCrossChainSwap`](https://github.com/randa-mu/onlyswaps-solidity/blob/70d423aa6263bef123f409b6c38dbe5d63fb006a/src/Router.sol#L124) only checks DestinationMapping, and not AllowedDestination. It needs to be consistent along with allow/disallow admin logic. For example, the admin might disallow a chain but users and solvers will still be able to interact with it (if the token is not removed from the relevant data structure)**  
*Response:*  
In addition to the check on the destination token mapping, we have added a validation for the destination chain id in `requestCrossChainSwap`. Please see commit [`5e4b24b32d37f93df4a0291d1b4e94b26f867682`](https://github.com/randa-mu/onlyswaps-solidity/pull/71/commits/5e4b24b32d37f93df4a0291d1b4e94b26f867682) for details.

**F4. Admin can [delay the scheduled upgrades](https://github.com/randa-mu/onlyswaps-solidity/blob/70d423aa6263bef123f409b6c38dbe5d63fb006a/src/Router.sol#L476) indefinitely.**  
*Response:*  
The ability for the admin to indefinitely delay scheduled upgrades has been addressed. The `onlyAdmin` modifier has been replaced with a requirement for a BLS signature as an input parameter, which is now used to validate changes to `minimumContractUpgradeDelay`. See commit [`27fee3c1c982fafe6b6c4a22578dc7221ad616b5`](https://github.com/randa-mu/onlyswaps-solidity/pull/72/commits/27fee3c1c982fafe6b6c4a22578dc7221ad616b5) for details.

**F5. Probably there should be a timeout in `requestCrossChainSwap`. Right now the users cannot get their funds back if the solvers do not fulfil their order.**  
*Response:*  
[TODO: Add response and commit hash]

**F6. Remark: in the UI you should probably check that a solver has not already fulfilled a request before allowing the user to perform the `updateSolverFeesIfUnfulfilled`**  
*Response:*  
Thank you for the suggestion. We agree that adding a UI check to verify whether a solver has already fulfilled a request before allowing the `updateSolverFeesIfUnfulfilled` action would improve user experience and reduce the risk of unnecessary or invalid operations. We will implement this safeguard in the UI to ensure better consistency and prevent confusion.

**F7. Remark: There is a denial-of-service vulnerability in the `relayTokens` function** 
In our understanding, the flow in the protocol is the following: 
1. Any user can call `requestCrossChainSwap`, which creates a `requestId` and emits an event on the source chain.
2. Any solver (permissionless) can call `relayTokens`, passing `token`, `recipient`, `amountOut`, `requestId`, and `srcChainId`.
3. The code checks if the `requestId` has already been fulfilled and then saves/emits a `SwapReceipt` on the destination chain.
4. Validators query both source and destination chains, map `requestIds` with `SwapReceipts` based on this logic (offchain), and if correct, generate a signature.
5. Someone with the signature calls the `rebalanceSolver` function, sending the funds to the solver on the source chain.

The issue here is that `relayTokens` is permissionless, and the `requestId` is passed as a parameter and is not bound to `amountOut`. Hence, anyone can perform a complete and extremely cheap DoS by simply observing `requestIds` in the source chain and calling the `relayTokens` with `0.00...01` as the `amountOut`, but using the proper `requestId`. 
The issue is that proper calls will fail after that because of this assertion. Our recommendation would be to add to the `relayTokens` all the values you need to reconstruct the `requestId`. To conclude, no funds would be lost, but they would be stuck in the contracts. 
Note that step 3 will correctly fail.
*Response:* 
We have addressed this issue by updating the `relayTokens` function to require all swap request parameters necessary to reconstruct the `requestId` on-chain. This ensures that the `requestId` is always derived from the actual parameters provided, preventing mismatches and mitigating the described denial-of-service vulnerability. See commit [`ab187063656f84894508b60d633c385c87fbda5f`](https://github.com/randa-mu/onlyswaps-solidity/pull/73/commits/ab187063656f84894508b60d633c385c87fbda5f) for details.


## Others

**SwapRequestReceipt parameters updated**
We have updated the `SwapRequestReceipt` parameters to include the `tokenIn` and `tokenOut` instead of only a `token` parameter representing the `tokenOut`. Also updated the `getSwapRequestReceipt` function accordingly. See commit [`71de7485f4ed169b8b1c4ce5983233ecf718a184`](https://github.com/randa-mu/onlyswaps-solidity/pull/74/commits/71de7485f4ed169b8b1c4ce5983233ecf718a184) for details.
