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
        return vm.parseJsonAddress(json, jsonKey);
    }

    function _readOnlySwapsJsonToStruct(string memory filePath)
        internal
        view
        returns (OnlySwapsDeploymentAddresses memory result)
    {
        string memory fullPath = _constructJsonFilePath(filePath);

        result.bn254SignatureVerifierAddress =
            vm.parseJsonAddress(vm.readFile(fullPath), ".bn254SignatureVerifierAddress");

        result.routerAddress =
            vm.parseJsonAddress(vm.readFile(fullPath), ".routerAddress");

        result.rusdAddress = vm.parseJsonAddress(vm.readFile(fullPath), ".rusdAddress");
    }

    function _writeOnlyswapsStructToJson(string memory filePath, OnlySwapsDeploymentAddresses memory data) internal {
        string memory json;
        json = vm.serializeAddress("root", "bn254SignatureVerifierAddress", data.bn254SignatureVerifierAddress);
        json = vm.serializeAddress(
            "root", "routerAddress", data.routerAddress
        );
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
}
