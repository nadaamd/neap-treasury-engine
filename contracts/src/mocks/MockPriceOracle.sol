// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

contract MockPriceOracle is IPriceOracle {
    mapping(bytes32 pair => uint256) public priceWad;
    mapping(bytes32 pair => uint64) public updatedAtOf;

    function key(address base, address quote) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(base, quote));
    }

    function set(address base, address quote, uint256 p) external {
        bytes32 k = key(base, quote);
        priceWad[k] = p;
        // forge-lint: disable-next-line(unsafe-typecast)
        updatedAtOf[k] = uint64(block.timestamp);
    }

    function setUpdatedAt(address base, address quote, uint64 ts) external {
        updatedAtOf[key(base, quote)] = ts;
    }

    /// @inheritdoc IPriceOracle
    function price(address base, address quote) external view returns (uint256, uint64) {
        bytes32 k = key(base, quote);
        return (priceWad[k], updatedAtOf[k]);
    }
}
