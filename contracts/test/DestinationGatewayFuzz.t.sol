// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {GatewaySecurityFixture} from "./helpers/GatewaySecurityFixture.sol";
import {DestinationGateway} from "../src/DestinationGateway.sol";
import {MessageDomainVerifier} from "../src/MessageDomainVerifier.sol";
import {MessageReplayProtection} from "../src/MessageReplayProtection.sol";
import {RemoteGatewayRegistry} from "../src/RemoteGatewayRegistry.sol";
import {PBFTCertificateVerifier} from "../src/PBFTCertificateVerifier.sol";
import {MessageMerkle} from "../src/MessageMerkle.sol";
import {GatewayReceiverFixture} from "./mocks/GatewayReceiverFixture.sol";
import {DeliveryPackageCodec as Codec} from "../src/libraries/DeliveryPackageCodec.sol";
import {PBFTCertificateCodec as Certificate} from "../src/libraries/PBFTCertificateCodec.sol";

contract DestinationGatewayFuzzTest is GatewaySecurityFixture {
    uint256 private constant POLICY_MUTATIONS = 7;

    struct BeforeRejection {
        bool originalConsumed;
        bool candidateConsumed;
        uint256 calls;
        uint256 originalCalls;
        uint256 candidateCalls;
    }

    function testFuzzFullWidthNonceReplayIsolation(uint256 nonce, address caller, bytes32 entropy, uint256 lengthSeed) public {
        bytes memory payload = _payload(entropy, bound(lengthSeed, 0, 256));
        Codec.Package memory first = _freshPackage(nonce, payload, LONG_DEADLINE, FIXTURE_FIRST_AUTHORITY);
        Codec.Package memory other = _freshPackage(nonce ^ 1, payload, LONG_DEADLINE, FIXTURE_SECOND_AUTHORITY);
        assertNotEq(first.message.messageId, other.message.messageId);
        _positiveThenRestore(first);
        gateway.execute(_encode(first));
        assertFalse(gateway.isMessageExecuted(other.message.messageId));
        assertEq(receiver.callsByMessage(other.message.messageId), 0);
        _rejectPackage(first, first.message.messageId,
            abi.encodeWithSelector(MessageReplayProtection.MessageAlreadyExecuted.selector, first.message.messageId), caller);
        gateway.execute(_encode(other));
        assertEq(receiver.callsByMessage(first.message.messageId), 1);
        assertEq(receiver.callsByMessage(other.message.messageId), 1);
    }

    function testFuzzAuthenticatedPolicyMutationsCannotExecute(uint256 value, uint256 kindSeed, address caller) public {
        Codec.Package memory pack = _freshPackage(value, abi.encode(value), LONG_DEADLINE, FIXTURE_SECOND_AUTHORITY);
        _positiveThenRestore(pack);
        bytes memory valid = _encode(pack);
        bytes32 originalId = pack.message.messageId;
        uint256 kind = bound(kindSeed, 0, POLICY_MUTATIONS - 1);
        bytes memory expected;
        if (kind == 0) {
            pack.message.sourceDomain = value == SOURCE ? value ^ 1 : value;
            expected = abi.encodeWithSelector(RemoteGatewayRegistry.UnknownSourceDomain.selector, pack.message.sourceDomain);
        } else if (kind == 1) {
            pack.message.sourceGateway = address(uint160(SOURCE_GATEWAY) ^ 1);
            expected = abi.encodeWithSelector(RemoteGatewayRegistry.UntrustedRemoteGateway.selector,
                SOURCE, pack.message.sourceGateway, SOURCE_GATEWAY);
        } else if (kind == 2) {
            pack.message.destinationDomain = value == DESTINATION ? value ^ 1 : value;
            expected = abi.encodeWithSelector(MessageDomainVerifier.InvalidDestinationDomain.selector, DESTINATION, pack.message.destinationDomain);
        } else if (kind == 3) {
            pack.message.destinationGateway = address(uint160(address(gateway)) ^ 1);
            expected = abi.encodeWithSelector(MessageDomainVerifier.DestinationGatewayMismatch.selector, address(gateway), pack.message.destinationGateway);
        } else if (kind == 4) {
            pack.message.destinationReceiver = address(0);
            expected = abi.encodeWithSelector(MessageDomainVerifier.InvalidDestinationReceiver.selector);
        } else if (kind == 5) {
            pack.message.deadline = START_TIME - bound(value, 0, 60);
            expected = abi.encodeWithSelector(MessageDomainVerifier.MessageExpired.selector, pack.message.deadline, START_TIME);
        } else {
            // Only the message-version byte is narrowed; bound has already enforced its uint8 range.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 version = uint8(bound(value, 0, 255));
            pack.message.version = version == 2 ? 0 : version;
            expected = abi.encodeWithSelector(MessageDomainVerifier.UnsupportedMessageVersion.selector, pack.message.version);
        }
        // All new identities, membership, roots and real signatures are consistent; only local policy is wrong.
        _authenticate(pack, FIXTURE_SECOND_AUTHORITY);
        _rejectPackage(pack, originalId, expected, caller);
        gateway.execute(valid);
        assertEq(receiver.callsByMessage(originalId), 1);
        assertFalse(gateway.isMessageExecuted(pack.message.messageId));
    }

    function testFuzzMerkleOrQuorumMutationAllowsUntamperedRetry(uint256 nonce, uint256 mask, bool merkle, address caller) public {
        Codec.Package memory pack = _freshPackage(nonce, "", LONG_DEADLINE, FIXTURE_SECOND_AUTHORITY);
        _positiveThenRestore(pack);
        bytes memory valid = _encode(pack);
        bytes memory expected;
        if (merkle) {
            pack.envelope.siblings[0] ^= bytes32(mask == 0 ? 1 : mask);
            bytes32 alteredRoot = MessageMerkle.hashNode(
                MessageMerkle.computeLeaf(pack.batch.batchId, 0, pack.message.messageId), pack.envelope.siblings[0]);
            expected = abi.encodeWithSelector(MessageMerkle.MerkleRootMismatch.selector, pack.envelope.messageRoot, alteredRoot);
        } else {
            (uint8 version, bytes memory statement, bytes32 digest, Certificate.Evidence[] memory votes) =
                abi.decode(pack.envelope.certificate, (uint8, bytes, bytes32, Certificate.Evidence[]));
            votes[1] = votes[0];
            pack.envelope.certificate = abi.encode(version, statement, digest, votes);
            expected = abi.encodeWithSelector(PBFTCertificateVerifier.NoncanonicalSigners.selector);
        }
        _rejectPackage(pack, pack.message.messageId, expected, caller);
        gateway.execute(valid);
        assertEq(receiver.callsByMessage(pack.message.messageId), 1);
    }

    function testFuzzReentryAndDownstreamRollback(uint256 nonce, bool failFirst, address caller) public {
        Codec.Package memory pack = _freshPackage(nonce, abi.encode(nonce), LONG_DEADLINE, FIXTURE_FIRST_AUTHORITY);
        _positiveThenRestore(pack);
        bytes memory nested = abi.encodeCall(DestinationGateway.execute, (_encode(pack)));
        receiver.configure(gateway, failFirst, nested);
        if (failFirst) {
            _rejectPackage(pack, pack.message.messageId, abi.encodeWithSelector(GatewayReceiverFixture.ReceiverRejected.selector), caller);
            assertEq(receiver.callsByMessage(pack.message.messageId), 0);
            receiver.configure(gateway, false, nested);
        }
        gateway.execute(_encode(pack));
        assertTrue(receiver.observedConsumed());
        assertFalse(receiver.nestedSuccess());
        assertEq(receiver.nestedResult(), abi.encodeWithSelector(MessageReplayProtection.MessageAlreadyExecuted.selector, pack.message.messageId));
        assertEq(receiver.callsByMessage(pack.message.messageId), 1);
    }

    function testFuzzDifferentCanonicalWrapperCannotBypassMessageReplay(uint256 nonce, uint256 jobSeed) public {
        Codec.Package memory pack = _freshPackage(nonce, "", LONG_DEADLINE, FIXTURE_SECOND_AUTHORITY);
        bytes memory original = _encode(pack);
        gateway.execute(original);
        pack.envelope.deliveryJobId = vm.toString(jobSeed);
        pack.envelope.certificate = _makeCertificate(validators,
            _statement(validators, pack, Certificate.EPOCH_VERSION, FIXTURE_SECOND_AUTHORITY, 2), FIXTURE_COMMITTEE_SIZE);
        bytes memory different = _encode(pack);
        assertNotEq(original, different);
        _rejectPackage(pack, pack.message.messageId,
            abi.encodeWithSelector(MessageReplayProtection.MessageAlreadyExecuted.selector, pack.message.messageId), address(0xABC));
        assertEq(receiver.callsByMessage(pack.message.messageId), 1);
    }

    function testFuzzOuterExecuteFramingCannotConsume(uint256 nonce, uint256 mutationSeed, uint256 lengthSeed) public {
        Codec.Package memory pack = _freshPackage(nonce, "", LONG_DEADLINE, FIXTURE_FIRST_AUTHORITY);
        _positiveThenRestore(pack);
        bytes memory inner = _encode(pack);
        bytes memory canonical = abi.encodeCall(DestinationGateway.execute, (inner));
        bytes memory malformed;
        uint256 mutation = bound(mutationSeed, 0, 4);
        bytes memory expected = abi.encodeWithSelector(DestinationGateway.InvalidExecutionEncoding.selector);
        if (mutation == 0) {
            uint256 length = bound(lengthSeed, 0, canonical.length - 1);
            malformed = new bytes(length);
            for (uint256 index = 0; index < length; index++) malformed[index] = canonical[index];
            // Depending on the cut, Solidity dispatch rejects before the Gateway framing guard is reached.
        } else if (mutation == 1) malformed = bytes.concat(canonical, new bytes(bound(lengthSeed, 1, 32)));
        else if (mutation == 2) {
            malformed = bytes.concat(DestinationGateway.execute.selector, abi.encode(uint256(64)),
                abi.encode(uint256(0)), abi.encode(inner.length), inner);
        } else if (mutation == 3) {
            malformed = canonical;
            _putWord(malformed, 36, malformed.length + 32);
            expected = "";
        } else {
            malformed = abi.encodeCall(DestinationGateway.execute, (bytes.concat(inner, hex"00")));
            malformed[malformed.length - 1] = bytes1(0x01);
        }
        vm.recordLogs();
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory reason) = address(gateway).call(malformed);
        assertFalse(success);
        if (mutation == 0 && reason.length == 0) { /* exact ABI dispatcher rejection */ }
        else assertEq(reason, expected);
        assertFalse(gateway.isMessageExecuted(pack.message.messageId));
        assertEq(receiver.calls(), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        gateway.execute(inner);
        assertEq(receiver.callsByMessage(pack.message.messageId), 1);
    }

    function _rejectPackage(Codec.Package memory pack, bytes32 originalId, bytes memory expected, address caller) private {
        BeforeRejection memory beforeState;
        beforeState.originalConsumed = gateway.isMessageExecuted(originalId);
        beforeState.candidateConsumed = gateway.isMessageExecuted(pack.message.messageId);
        beforeState.calls = receiver.calls();
        beforeState.originalCalls = receiver.callsByMessage(originalId);
        beforeState.candidateCalls = receiver.callsByMessage(pack.message.messageId);
        bytes memory data = abi.encodeCall(DestinationGateway.execute, (_encode(pack)));
        vm.recordLogs();
        vm.prank(_safeCaller(caller));
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory reason) = address(gateway).call(data);
        assertFalse(success);
        assertEq(reason, expected);
        assertEq(gateway.isMessageExecuted(originalId), beforeState.originalConsumed);
        assertEq(gateway.isMessageExecuted(pack.message.messageId), beforeState.candidateConsumed);
        assertEq(receiver.calls(), beforeState.calls);
        assertEq(receiver.callsByMessage(originalId), beforeState.originalCalls);
        assertEq(receiver.callsByMessage(pack.message.messageId), beforeState.candidateCalls);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
    }

    function _safeCaller(address caller) private view returns (address) {
        if (caller == address(0) || caller == address(gateway) || caller == address(receiver) || caller == address(vm)) return address(0xABC);
        return caller;
    }
}
