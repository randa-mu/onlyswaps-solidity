// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Script} from "forge-std/Script.sol";
import {OnlySwapsDeploymentAddresses} from "./TypesLib.sol";
import {Constants} from "../onlyswaps/libraries/Constants.sol";

contract JsonUtils is Script {
    function _readAddressFromJsonInput(string memory filePath, string memory contractName)
        internal
        view
        returns (address)
    {
        string memory path = _constructJsonFilePath(filePath);
        string memory json = vm.readFile(path);

        string memory jsonKey = string.concat(".", contractName);

        if (vm.keyExists(json, jsonKey)) {
            return vm.parseJsonAddress(json, jsonKey);
        } else {
            return address(0);
        }
    }

    function _readOnlySwapsJsonToStruct(string memory filePath)
        internal
        view
        returns (OnlySwapsDeploymentAddresses memory result)
    {
        result.bn254SwapRequestSignatureSchemeAddress = _readAddressFromJsonInput(filePath, "bn254SwapRequestSignatureSchemeAddress");
        result.bn254ContractUpgradeSignatureSchemeAddress = _readAddressFromJsonInput(filePath, "bn254ContractUpgradeSignatureSchemeAddress");
        result.routerAddress = _readAddressFromJsonInput(filePath, "routerAddress");
        result.rusdFaucet = _readAddressFromJsonInput(filePath, "rusdFaucet");
    }

    function _writeOnlySwapsStructToJson(string memory filePath, OnlySwapsDeploymentAddresses memory data) internal {
        string memory json;
        json = vm.serializeAddress("root", "bn254SwapRequestSignatureSchemeAddress", data.bn254SwapRequestSignatureSchemeAddress);
        json = vm.serializeAddress("root", "bn254ContractUpgradeSignatureSchemeAddress", data.bn254ContractUpgradeSignatureSchemeAddress);
        json = vm.serializeAddress("root", "routerAddress", data.routerAddress);
        json = vm.serializeAddress("root", "rusdFaucet", data.rusdFaucet);

        vm.writeJson(json, _constructJsonFilePath(filePath));
    }

    function _writeAddressToJsonInput(string memory filePath, string memory jsonKey, address contractAddress)
        internal
    {
        string memory obj = "deployment addresses input";
        string memory output = vm.serializeAddress(obj, jsonKey, contractAddress);
        vm.writeJson(output, _constructJsonFilePath(filePath));
    }

    function _readJsonFile(string memory filePath) internal view returns (string memory) {
        return vm.readFile(_constructJsonFilePath(filePath));
    }

    function _constructJsonFilePath(string memory filePath) internal view returns (string memory) {
        string memory root = vm.projectRoot();
        return string.concat(root, filePath);
    }

    function _filePathExists(string memory filePath) internal view returns (bool fileExists) {
        // Assume the file exists until proven otherwise
        fileExists = true;

        // Attempt to read the file using vm.readFile(filePath)
        // This will throw an error if the file doesn't exist, which we catch below
        try vm.readFile(_constructJsonFilePath((filePath))) returns (string memory /* content */ ) {
            // store the file contents (optional, in case needed later)
        } catch {
            fileExists = false;
        }
    }

    function _storeOnlySwapsAddressInJson(string memory path, string memory key, address value) internal {
        OnlySwapsDeploymentAddresses memory data;

        if (_filePathExists(path)) {
            data = _readOnlySwapsJsonToStruct(path);
        }

        // Match the key to known json object fields and update accordingly
        bytes32 hashedKey = keccak256(bytes(key));

        if (hashedKey == keccak256(bytes(Constants.KEY_RUSD))) {
            data.rusdFaucet = value;
        } else if (hashedKey == keccak256(bytes(Constants.KEY_ROUTER))) {
            data.routerAddress = value;
        } else if (hashedKey == keccak256(bytes(Constants.KEY_BN254_SWAP_REQUEST_SIGNATURE_SCHEME))) {
            data.bn254SwapRequestSignatureSchemeAddress = value;
        } else if (hashedKey == keccak256(bytes(Constants.KEY_BN254_CONTRACT_UPGRADE_SIGNATURE_SCHEME))) {
            data.bn254ContractUpgradeSignatureSchemeAddress = value;
        } else {
            revert("Unsupported key in _storeOnlySwapsAddressInJson");
        }

        _writeOnlySwapsStructToJson(path, data);
    }
}
