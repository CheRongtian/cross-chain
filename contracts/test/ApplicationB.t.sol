// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ApplicationB} from "../src/ApplicationB.sol";
import {MockDestinationGateway} from "./mocks/MockDestinationGateway.sol";

contract ApplicationBTest is Test {
    uint8 private constant COMMAND_VERSION = 1;
    uint8 private constant GRANT_ACTION = 1;
    uint256 private constant COMMAND_LENGTH = 96;
    uint256 private constant VECTOR_COUNT = 2;
    uint256 private constant MALFORMED_CASE_COUNT = 7;
    uint256 private constant DIRTY_PADDING_COUNT = 3;
    uint256 private constant EVENT_TOPIC_COUNT = 3;
    uint256 private constant ABSENT_MUTATION_COUNT = 4;
    address private constant SUPPLIER_ONE = address(0x1234567890123456789012345678901234567890);
    address private constant SUPPLIER_TWO = address(0x9876543210987654321098765432109876543210);
    address private constant USER = address(0xA11);
    address private constant RELAYER_LIKE = address(0xB22);
    bytes32 private constant FIRST_ID = bytes32(uint256(1));
    bytes32 private constant SECOND_ID = bytes32(uint256(2));
    bytes32 private constant GRANTED_TOPIC = keccak256("VerifiedSupplierGranted(bytes32,address)");

    ApplicationB private application;
    MockDestinationGateway private gateway;
    MockDestinationGateway private otherGateway;
    string private fixture;

    function setUp() public {
        gateway = new MockDestinationGateway();
        otherGateway = new MockDestinationGateway();
        application = new ApplicationB(address(gateway));
        // Read the fixed public command fixture; no generator or expected-byte rewriting is involved.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        fixture = vm.readFile(string.concat(vm.projectRoot(), "/../test-vectors/application-b-commands.json"));
    }

    function testConstructorBindsExactGatewayAndRejectsZero() public {
        assertEq(application.destinationGateway(), address(gateway));
        assertEq(application.COMMAND_VERSION(), COMMAND_VERSION);
        assertEq(application.ACTION_GRANT_VERIFIED_SUPPLIER(), GRANT_ACTION);
        assertFalse(application.isVerifiedSupplier(SUPPLIER_ONE));
        assertFalse(application.isVerifiedSupplier(address(0)));
        vm.expectRevert(ApplicationB.InvalidDestinationGateway.selector);
        new ApplicationB(address(0));
    }

    function testNonzeroGatewayDoesNotRequireCodeAtConstruction() public {
        assertEq(USER.code.length, 0);
        ApplicationB configured = new ApplicationB(USER);
        assertEq(configured.destinationGateway(), USER);
        vm.prank(USER);
        configured.handleCrossChainMessage(FIRST_ID, _payload(SUPPLIER_ONE));
        assertTrue(configured.isVerifiedSupplier(SUPPLIER_ONE));
    }

    function testDirectUserAndRelayerCallsRejectBeforePayloadDecoding() public {
        vm.recordLogs();
        vm.expectRevert(_unauthorized(USER, address(gateway)));
        vm.prank(USER);
        application.handleCrossChainMessage(FIRST_ID, _payload(SUPPLIER_ONE));
        vm.expectRevert(_unauthorized(RELAYER_LIKE, address(gateway)));
        vm.prank(RELAYER_LIKE);
        application.handleCrossChainMessage(FIRST_ID, _payload(SUPPLIER_ONE));
        vm.expectRevert(_unauthorized(USER, address(gateway)));
        vm.prank(USER);
        application.handleCrossChainMessage(FIRST_ID, bytes(""));
        assertFalse(application.isVerifiedSupplier(SUPPLIER_ONE));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function testSameBytecodeAtAnotherAddressHasNoAuthority() public {
        assertNotEq(address(gateway), address(otherGateway));
        assertEq(address(gateway).code, address(otherGateway).code);
        vm.recordLogs();
        vm.expectRevert(_unauthorized(address(otherGateway), address(gateway)));
        otherGateway.forwardMessage(application, FIRST_ID, _payload(SUPPLIER_ONE));
        assertFalse(application.isVerifiedSupplier(SUPPLIER_ONE));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function testTrustedTxOriginDoesNotAuthorizeAnUntrustedContract() public {
        ApplicationB eoaBound = new ApplicationB(USER);
        vm.expectRevert(_unauthorized(address(otherGateway), USER));
        vm.prank(RELAYER_LIKE, USER);
        otherGateway.forwardMessage(eoaBound, FIRST_ID, _payload(SUPPLIER_ONE));
        assertFalse(eoaBound.isVerifiedSupplier(SUPPLIER_ONE));
    }

    function testTrustedGatewayGrantsExactSupplierAndEmitsExactEvent() public {
        vm.recordLogs();
        gateway.forwardMessage(application, FIRST_ID, _payload(SUPPLIER_ONE));
        _assertGrantLog(vm.getRecordedLogs(), FIRST_ID, SUPPLIER_ONE);
        assertTrue(application.isVerifiedSupplier(SUPPLIER_ONE));
        assertFalse(application.isVerifiedSupplier(SUPPLIER_TWO));
        assertFalse(application.isVerifiedSupplier(address(gateway)));
        assertFalse(application.isVerifiedSupplier(address(this)));
    }

    // Each frozen case calls the configured local fixture using independent expected ABI bytes.
    // forge-lint: disable-next-item(calls-loop)
    function testFrozenCommandBytesMatchSolidityAndExecuteIndependently() public {
        assertEq(vm.parseJsonString(fixture, ".abiTypes"), "uint8,uint8,address");
        assertEq(vm.parseJsonUint(fixture, ".payloadLength"), COMMAND_LENGTH);
        for (uint256 index = 0; index < VECTOR_COUNT; index++) {
            string memory path = string.concat(".vectors[", vm.toString(index), "]");
            address supplier = vm.parseJsonAddress(fixture, string.concat(path, ".supplier"));
            assertEq(vm.parseJsonUint(fixture, string.concat(path, ".version")), COMMAND_VERSION);
            assertEq(vm.parseJsonUint(fixture, string.concat(path, ".action")), GRANT_ACTION);
            bytes memory expected = vm.parseJsonBytes(fixture, string.concat(path, ".expectedPayload"));
            assertEq(expected.length, COMMAND_LENGTH);
            assertEq(expected, _payload(supplier));
            assertFalse(application.isVerifiedSupplier(supplier));
            gateway.forwardMessage(application, FIRST_ID, expected);
            assertTrue(application.isVerifiedSupplier(supplier));
        }
        // Reusing a correlation ID here deliberately demonstrates that replay authority is outside this receiver.
        // These are isolated trusted-caller fixtures, not claims of two valid protocol messages with one ID.
    }

    function testRepeatedBusinessGrantIsDistinctFromMessageReplay() public {
        gateway.forwardMessage(application, FIRST_ID, _payload(SUPPLIER_ONE));
        _reject(_payload(SUPPLIER_ONE), abi.encodeWithSelector(ApplicationB.AlreadyVerifiedSupplier.selector, SUPPLIER_ONE));
        // _reject uses a different correlation ID; redundant supplier state is a business error.
        gateway.forwardMessage(application, SECOND_ID, _payload(SUPPLIER_TWO));
        assertTrue(application.isVerifiedSupplier(SUPPLIER_ONE));
        assertTrue(application.isVerifiedSupplier(SUPPLIER_TWO));
    }

    function testWrongVersionActionAndZeroSupplierPreserveState() public {
        gateway.forwardMessage(application, FIRST_ID, _payload(SUPPLIER_ONE));
        _reject(abi.encode(uint8(2), GRANT_ACTION, SUPPLIER_TWO),
            abi.encodeWithSelector(ApplicationB.UnsupportedCommandVersion.selector, uint256(2)));
        _reject(abi.encode(COMMAND_VERSION, uint8(2), SUPPLIER_TWO),
            abi.encodeWithSelector(ApplicationB.UnsupportedBusinessAction.selector, uint256(2)));
        _reject(_payload(address(0)), abi.encodeWithSelector(ApplicationB.InvalidSupplier.selector));
        assertTrue(application.isVerifiedSupplier(SUPPLIER_ONE));
        assertFalse(application.isVerifiedSupplier(SUPPLIER_TWO));
    }

    // Every bounded malformed fixture must produce the exact payload error without a business event/write.
    // forge-lint: disable-next-item(calls-loop)
    function testEmptyTruncatedTrailingPackedAndWrappedPayloadsReject() public {
        bytes memory valid = _payload(SUPPLIER_ONE);
        bytes[MALFORMED_CASE_COUNT] memory malformed = [bytes(""), bytes(hex"01"), abi.encode(COMMAND_VERSION, GRANT_ACTION),
            new bytes(COMMAND_LENGTH - 1), bytes.concat(valid, hex"00"),
            abi.encodePacked(COMMAND_VERSION, GRANT_ACTION, SUPPLIER_ONE), abi.encode(valid)];
        for (uint256 index = 0; index < malformed.length; index++) {
            _reject(malformed[index], abi.encodeWithSelector(ApplicationB.InvalidBusinessPayload.selector));
        }
    }

    // Full-word construction deliberately creates noncanonical uint8 and address padding, without truncating it.
    // forge-lint: disable-next-item(calls-loop)
    function testNoncanonicalScalarAndAddressPaddingRejectPrecisely() public {
        uint256 supplier = uint256(uint160(SUPPLIER_ONE));
        bytes[DIRTY_PADDING_COUNT] memory malformed = [
            abi.encode(uint256(type(uint8).max) + 1, uint256(GRANT_ACTION), supplier),
            abi.encode(uint256(COMMAND_VERSION), uint256(type(uint8).max) + 1, supplier),
            abi.encode(uint256(COMMAND_VERSION), uint256(GRANT_ACTION), (uint256(1) << 160) | supplier)
        ];
        for (uint256 index = 0; index < malformed.length; index++) {
            _reject(malformed[index], abi.encodeWithSelector(ApplicationB.InvalidBusinessPayload.selector));
        }
    }

    function testFuzzFullSupplierAddressAndCorrelationIdArePreserved(address supplier, bytes32 messageId) public {
        vm.assume(supplier != address(0));
        vm.recordLogs();
        gateway.forwardMessage(application, messageId, _payload(supplier));
        assertTrue(application.isVerifiedSupplier(supplier));
        _assertGrantLog(vm.getRecordedLogs(), messageId, supplier);
    }

    // Probe the absence of alternate typed/admin paths; exact empty failure data is part of the assertion.
    // forge-lint: disable-next-item(calls-loop)
    function testNoTypedOrAdminGrantBypassExists() public {
        string[ABSENT_MUTATION_COUNT] memory signatures = ["grantVerifiedSupplier(address)",
            "grantVerifiedSupplierByAdmin(address)", "forceVerifySupplier(address)", "setDestinationGateway(address)"];
        vm.recordLogs();
        for (uint256 index = 0; index < signatures.length; index++) {
            // Unknown selectors cannot be represented by the typed receiver interface.
            // forge-lint: disable-next-line(low-level-calls)
            (bool success, bytes memory result) = address(application).call(abi.encodeWithSignature(signatures[index], SUPPLIER_ONE));
            assertFalse(success);
            assertEq(result, bytes(""));
        }
        assertFalse(application.isVerifiedSupplier(SUPPLIER_ONE));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    // Malformed-case loops intentionally call this local mock; the business revert must propagate unchanged.
    // forge-lint: disable-next-item(calls-loop)
    function _reject(bytes memory payload, bytes memory expectedError) private {
        bool firstBefore = application.isVerifiedSupplier(SUPPLIER_ONE);
        bool secondBefore = application.isVerifiedSupplier(SUPPLIER_TWO);
        vm.recordLogs();
        vm.expectRevert(expectedError);
        gateway.forwardMessage(application, SECOND_ID, payload);
        assertEq(application.isVerifiedSupplier(SUPPLIER_ONE), firstBefore);
        assertEq(application.isVerifiedSupplier(SUPPLIER_TWO), secondBefore);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function _payload(address supplier) private pure returns (bytes memory) {
        return abi.encode(COMMAND_VERSION, GRANT_ACTION, supplier);
    }

    function _unauthorized(address caller, address expected) private pure returns (bytes memory) {
        return abi.encodeWithSelector(ApplicationB.UnauthorizedDestinationGateway.selector, caller, expected);
    }

    function _assertGrantLog(Vm.Log[] memory logs, bytes32 messageId, address supplier) private view {
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(application));
        assertEq(logs[0].topics.length, EVENT_TOPIC_COUNT);
        assertEq(logs[0].topics[0], GRANTED_TOPIC);
        assertEq(logs[0].topics[1], messageId);
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(supplier))));
        assertEq(logs[0].data, bytes(""));
    }
}
