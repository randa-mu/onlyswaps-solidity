// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {Script} from "forge-std/Script.sol";
import {OnlySwapsDeploymentAddresses} from "./TypesLib.sol";

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
        result.bn254SignatureSchemeAddress = _readAddressFromJsonInput(filePath, "bn254SignatureSchemeAddress");
        result.routerAddress = _readAddressFromJsonInput(filePath, "routerAddress");
        result.rusdAddress = _readAddressFromJsonInput(filePath, "rusdAddress");
    }

    function _writeOnlySwapsStructToJson(string memory filePath, OnlySwapsDeploymentAddresses memory data) internal {
        string memory json;
        json = vm.serializeAddress("root", "bn254SignatureSchemeAddress", data.bn254SignatureSchemeAddress);
        json = vm.serializeAddress("root", "routerAddress", data.routerAddress);
        json = vm.serializeAddress("root", "rusdAddress", data.rusdAddress);

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
        try vm.readFile(_constructJsonFilePath((filePath))) returns (string memory /* content */) {
            // store the file contents (optional, in case needed later)
        } catch {
            fileExists = false;
        }
    }
}
