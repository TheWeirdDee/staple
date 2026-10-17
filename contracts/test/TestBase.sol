// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Minimal subset of Foundry cheatcodes used by the tests (avoids vendoring forge-std).
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function sign(uint256 pk, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function addr(uint256 pk) external pure returns (address);
    function chainId(uint256) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool c, string memory m) internal pure {
        require(c, m);
    }

    function assertEqU(uint256 a, uint256 b, string memory m) internal pure {
        if (a != b) revert(string(abi.encodePacked(m, ": ", _u(a), " != ", _u(b))));
    }

    function assertEqI(int256 a, int256 b, string memory m) internal pure {
        if (a != b) revert(string(abi.encodePacked(m, ": int mismatch")));
    }

    function _u(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = abi.encodePacked(bytes1(uint8(48 + (v % 10))), b);
            v /= 10;
        }
        return string(b);
    }
}
