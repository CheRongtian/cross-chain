// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ForwardAuthorizationCodec, FORWARD_AUTHORIZATION_TYPEHASH} from "../src/ForwardAuthorizationCodec.sol";
import {CROSS_CHAIN_MESSAGE_TYPEHASH} from "../src/MessageCodec.sol";
import {ForwardAuthorizationVector} from "../generated/ForwardAuthorizationVector.sol";

contract ForwardAuthorizationCodecTest is Test {
    function testSharedForwardIntentEncodingAndDigest() public pure {
        ForwardAuthorizationCodec.Intent memory intent = ForwardAuthorizationVector.intent();
        assertEq(ForwardAuthorizationCodec.encode(intent), ForwardAuthorizationVector.expectedEncoding());
        assertEq(ForwardAuthorizationCodec.digest(intent), ForwardAuthorizationVector.expectedDigest());
        assertTrue(FORWARD_AUTHORIZATION_TYPEHASH != CROSS_CHAIN_MESSAGE_TYPEHASH);
        (uint256 hi, uint256 lo) = ForwardAuthorizationCodec.split(ForwardAuthorizationCodec.digest(intent));
        assertEq(hi, ForwardAuthorizationVector.expectedHi());
        assertEq(lo, ForwardAuthorizationVector.expectedLo());
    }
    function testDigestLimbsPreserveLeadingZerosAndFullWidth() public pure {
        (uint256 hi, uint256 lo) = ForwardAuthorizationCodec.split(bytes32((uint256(1) << 128) | 2));
        assertEq(hi, 1); assertEq(lo, 2);
        (hi, lo) = ForwardAuthorizationCodec.split(bytes32(uint256(1) << 255));
        assertEq(hi, uint256(1) << 127); assertEq(lo, 0);
        (hi, lo) = ForwardAuthorizationCodec.split(bytes32(type(uint256).max));
        assertEq(hi, type(uint128).max); assertEq(lo, type(uint128).max);
        assertEq((hi << 128) | lo, type(uint256).max);
    }
    function testEveryForwardIntentFieldChangesDigest() public pure {
        bytes32 original = ForwardAuthorizationVector.expectedDigest();
        for (uint256 field = 0; field < 11; field++) {
            ForwardAuthorizationCodec.Intent memory intent = ForwardAuthorizationVector.intent();
            if (field == 0) intent.protocolVersion += 1;
            if (field == 1) intent.action += 1;
            if (field == 2) intent.sourceDomain += 1;
            if (field == 3) intent.application = address(0x123);
            if (field == 4) intent.sourceGateway = address(0x123);
            if (field == 5) intent.destinationDomain += 1;
            if (field == 6) intent.destinationGateway = address(0x123);
            if (field == 7) intent.destinationReceiver = address(0x123);
            if (field == 8) intent.payloadHash = bytes32(uint256(123));
            if (field == 9) intent.deadline += 1;
            if (field == 10) intent.authorizedExecutor = address(0x123);
            assertTrue(ForwardAuthorizationCodec.digest(intent) != original);
        }
    }
}
