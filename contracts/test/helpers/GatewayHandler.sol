// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTestFixtures} from "./ProtocolTestFixtures.sol";
import {DeliveryCodecHarness} from "./DeliveryCodecHarness.sol";
import {DestinationGateway} from "../../src/DestinationGateway.sol";
import {MessageReplayProtection} from "../../src/MessageReplayProtection.sol";
import {MessageDomainVerifier} from "../../src/MessageDomainVerifier.sol";
import {MessageMerkle} from "../../src/MessageMerkle.sol";
import {RemoteGatewayRegistry} from "../../src/RemoteGatewayRegistry.sol";
import {ValidatorSetRegistry} from "../../src/ValidatorSetRegistry.sol";
import {PBFTCertificateVerifier} from "../../src/PBFTCertificateVerifier.sol";
import {MerkleInclusionVerifier} from "../../src/MerkleInclusionVerifier.sol";
import {GatewayReceiverFixture} from "../mocks/GatewayReceiverFixture.sol";
import {DeliveryPackageCodec as Codec} from "../../src/libraries/DeliveryPackageCodec.sol";
import {PBFTCertificateCodec as Certificate} from "../../src/libraries/PBFTCertificateCodec.sol";

/// @dev TEST-ONLY generated operation ordering around production execute(bytes). The model grants no authority.
contract GatewayHandler is ProtocolTestFixtures {
    enum Action { VALID, REPLAY, MERKLE, QC, DESTINATION, SOURCE, MALFORMED, EXPIRED, REENTRANT, DOWNSTREAM, ALTERNATE }

    DestinationGateway public immutable GATEWAY;
    GatewayReceiverFixture public immutable RECEIVER;
    DeliveryCodecHarness private immutable DECODER;
    ValidatorSetRegistry private immutable VALIDATORS;
    MerkleInclusionVerifier private immutable MERKLE;
    uint256 private immutable TIME_LIMIT;
    uint256 private constant MAX_ADVANCE = 60;
    bytes[] private packages;
    bytes private expiredPackage;
    bytes32 public immutable EXPIRED_ID;
    bytes32[] private ids;
    bytes32[] private payloadHashes;
    mapping(bytes32 messageId => uint256 successfulExecutions) public successes;
    uint256 public validSuccesses;
    uint256 public replayRejections;
    uint256 public invalidEvidenceRejections;
    uint256 public reentrantRejections;
    uint256 public downstreamRejections;
    uint256[11] public actionCalls;

    error UnexpectedGatewayOutcome(Action action, uint256 poolIndex, bool success, bytes actual, bytes expected);
    error ModelMismatch(Action action, uint256 poolIndex, bytes32 messageId);

    // The constructor only stores local evidence; setup separately demonstrates each positive fixture.
    // forge-lint: disable-next-item(calls-loop)
    constructor(DestinationGateway gateway, GatewayReceiverFixture receiver, DeliveryCodecHarness decoder,
        bytes[] memory validPackages, bytes memory expired)
    {
        GATEWAY = gateway;
        RECEIVER = receiver;
        DECODER = decoder;
        VALIDATORS = ValidatorSetRegistry(address(gateway.CERTIFICATE_VERIFIER().validatorSetRegistry()));
        MERKLE = gateway.MERKLE_VERIFIER();
        assertEq(validPackages.length, 6, "handler pool size");
        uint256 earliest = type(uint256).max;
        for (uint256 index = 0; index < validPackages.length; index++) {
            Codec.Package memory pack = decoder.decodePackage(validPackages[index]);
            packages.push(validPackages[index]);
            ids.push(pack.message.messageId);
            payloadHashes.push(pack.message.payloadHash);
            assertFalse(gateway.isMessageExecuted(pack.message.messageId));
            if (pack.message.deadline < earliest) earliest = pack.message.deadline;
            for (uint256 previous = 0; previous < index; previous++) assertNotEq(ids[previous], pack.message.messageId);
        }
        TIME_LIMIT = earliest;
        expiredPackage = expired;
        EXPIRED_ID = decoder.decodePackage(expired).message.messageId;
    }

    function executeValid(uint256 seed, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.VALID)]++;
        _execute(index, caller, Action.VALID);
        _assertModel(Action.VALID, index);
    }

    function replay(uint256 seed, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.REPLAY)]++;
        if (successes[ids[index]] == 0) _execute(index, caller, Action.REPLAY);
        _reject(index, packages[index], _replayReason(ids[index]), caller, Action.REPLAY);
        replayRejections++;
    }

    function invalidMerkle(uint256 seed, bytes32 mask, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.MERKLE)]++;
        Codec.Package memory pack = DECODER.decodePackage(packages[index]);
        pack.envelope.siblings[0] ^= mask == bytes32(0) ? bytes32(uint256(1)) : mask;
        bytes32 alteredRoot = MessageMerkle.hashNode(
            MessageMerkle.computeLeaf(pack.batch.batchId, 0, pack.message.messageId), pack.envelope.siblings[0]);
        _reject(index, _encode(pack), abi.encodeWithSelector(MessageMerkle.MerkleRootMismatch.selector,
            pack.envelope.messageRoot, alteredRoot), caller, Action.MERKLE);
        invalidEvidenceRejections++;
    }

    function invalidQC(uint256 seed, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.QC)]++;
        Codec.Package memory pack = DECODER.decodePackage(packages[index]);
        (uint8 version, bytes memory statement, bytes32 digest, Certificate.Evidence[] memory votes) =
            abi.decode(pack.envelope.certificate, (uint8, bytes, bytes32, Certificate.Evidence[]));
        votes[1] = votes[0];
        pack.envelope.certificate = abi.encode(version, statement, digest, votes);
        _reject(index, _encode(pack), abi.encodeWithSelector(PBFTCertificateVerifier.NoncanonicalSigners.selector), caller, Action.QC);
        invalidEvidenceRejections++;
    }

    function wrongDestination(uint256 seed, uint256 wrongDomain, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.DESTINATION)]++;
        Codec.Package memory pack = DECODER.decodePackage(packages[index]);
        uint256 local = pack.message.destinationDomain;
        pack.message.destinationDomain = wrongDomain == local ? wrongDomain ^ 1 : wrongDomain;
        _authenticateAttack(pack);
        bytes32 candidateId = pack.message.messageId;
        _reject(index, _encode(pack), abi.encodeWithSelector(MessageDomainVerifier.InvalidDestinationDomain.selector,
            local, pack.message.destinationDomain), caller, Action.DESTINATION);
        _assertUnconsumed(candidateId, Action.DESTINATION, index);
        invalidEvidenceRejections++;
    }

    function wrongSource(uint256 seed, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.SOURCE)]++;
        Codec.Package memory pack = DECODER.decodePackage(packages[index]);
        address trusted = pack.message.sourceGateway;
        pack.message.sourceGateway = address(uint160(trusted) ^ 1);
        _authenticateAttack(pack);
        _reject(index, _encode(pack), abi.encodeWithSelector(RemoteGatewayRegistry.UntrustedRemoteGateway.selector,
            pack.message.sourceDomain, pack.message.sourceGateway, trusted), caller, Action.SOURCE);
        _assertUnconsumed(pack.message.messageId, Action.SOURCE, index);
        invalidEvidenceRejections++;
    }

    function malformedPackage(uint256 seed, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.MALFORMED)]++;
        // A one-byte tail is bounded, noncanonical, and never repaired before production parsing.
        _reject(index, bytes.concat(packages[index], hex"01"), abi.encodeWithSelector(Codec.InvalidPackageEncoding.selector), caller, Action.MALFORMED);
        invalidEvidenceRejections++;
    }

    // Time belongs exclusively to this test EVM; comparing and advancing it is the expiry action's purpose.
    // This does not relax the production deadline check or assume a trusted production block timestamp.
    // forge-lint: disable-next-item(block-timestamp)
    function expiredMessage(uint256 deltaSeed, address caller) external {
        actionCalls[uint256(Action.EXPIRED)]++;
        Codec.Package memory pack = DECODER.decodePackage(expiredPackage);
        // Only this action advances time; each step is bounded, monotone and keeps the main pool usable.
        uint256 nowTime = block.timestamp;
        uint256 timestamp = (nowTime < pack.message.deadline ? pack.message.deadline : nowTime) + bound(deltaSeed, 0, MAX_ADVANCE);
        assertLt(timestamp, TIME_LIMIT, "handler time exhausted positive pool");
        vm.warp(timestamp);
        _reject(0, expiredPackage, abi.encodeWithSelector(MessageDomainVerifier.MessageExpired.selector,
            pack.message.deadline, timestamp), caller, Action.EXPIRED);
        _assertUnconsumed(EXPIRED_ID, Action.EXPIRED, 0);
        invalidEvidenceRejections++;
    }

    function sameMessageReentrant(uint256 seed, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.REENTRANT)]++;
        if (successes[ids[index]] != 0) {
            _reject(index, packages[index], _replayReason(ids[index]), caller, Action.REENTRANT);
            replayRejections++;
        } else {
            // _execute configures the same-message callback immediately before the real Gateway call.
            _execute(index, caller, Action.REENTRANT);
            assertTrue(RECEIVER.observedConsumed(), "callback before consumption");
            assertFalse(RECEIVER.nestedSuccess(), "same-message nested execution accepted");
            assertEq(RECEIVER.nestedResult(), _replayReason(ids[index]));
            reentrantRejections++;
            RECEIVER.configure(GATEWAY, false, "");
        }
        _assertModel(Action.REENTRANT, index);
    }

    function downstreamRevert(uint256 seed, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.DOWNSTREAM)]++;
        if (successes[ids[index]] != 0) {
            _reject(index, packages[index], _replayReason(ids[index]), caller, Action.DOWNSTREAM);
            replayRejections++;
        } else {
            RECEIVER.configure(GATEWAY, true, "");
            _reject(index, packages[index], abi.encodeWithSelector(GatewayReceiverFixture.ReceiverRejected.selector), caller, Action.DOWNSTREAM);
            RECEIVER.configure(GATEWAY, false, "");
            downstreamRejections++;
        }
        _assertModel(Action.DOWNSTREAM, index);
    }

    function alternateCanonicalReplay(uint256 seed, uint256 jobId, address caller) external {
        uint256 index = _index(seed);
        actionCalls[uint256(Action.ALTERNATE)]++;
        if (successes[ids[index]] == 0) _execute(index, caller, Action.ALTERNATE);
        Codec.Package memory pack = DECODER.decodePackage(packages[index]);
        pack.envelope.deliveryJobId = vm.toString(jobId);
        _reject(index, _encode(pack), _replayReason(ids[index]), caller, Action.ALTERNATE);
        replayRejections++;
    }

    function assertModel() external view {
        _assertModel(Action.VALID, 0);
    }

    function messageId(uint256 index) external view returns (bytes32) { return ids[index]; }

    // Model counters record completed production success, so they must follow the external execution.
    // The fixed test receiver only reenters the Gateway, never this handler; production replay protects
    // that nested execution. Moving the model update earlier would corrupt the observed-success model.
    // forge-lint: disable-next-item(reentrancy-no-eth)
    function _execute(uint256 index, address caller, Action action) private {
        if (successes[ids[index]] != 0) {
            _reject(index, packages[index], _replayReason(ids[index]), caller, action);
            replayRejections++;
            return;
        }
        RECEIVER.configure(GATEWAY, false, action == Action.REENTRANT
            ? abi.encodeCall(DestinationGateway.execute, (packages[index])) : bytes(""));
        (bool success, bytes memory actual) = _call(packages[index], caller);
        if (!success) revert UnexpectedGatewayOutcome(action, index, success, actual, "");
        successes[ids[index]]++;
        validSuccesses++;
        _assertModel(action, index);
    }

    function _reject(uint256 index, bytes memory encoded, bytes memory expected, address caller, Action action) private {
        uint256 callsBefore = RECEIVER.calls();
        vm.recordLogs();
        (bool success, bytes memory actual) = _call(encoded, caller);
        if (success || !_sameBytes(actual, expected)) revert UnexpectedGatewayOutcome(action, index, success, actual, expected);
        if (RECEIVER.calls() != callsBefore || vm.getRecordedLogs().length != 0) revert ModelMismatch(action, index, ids[index]);
        _assertModel(action, index);
    }

    // Called before success accounting by design. vm.prank and the fixed local Gateway/receiver pair
    // cannot call back into the handler; same-message Gateway reentrancy remains under test above.
    // The exemption follows these actual call sites as well as their _execute caller.
    // forge-lint: disable-next-item(reentrancy-no-eth)
    function _call(bytes memory encoded, address caller) private returns (bool success, bytes memory actual) {
        if (caller == address(0) || caller == address(GATEWAY) || caller == address(RECEIVER)
            || caller == address(this) || caller == address(vm)) caller = address(0xABC);
        bytes memory data = abi.encodeCall(DestinationGateway.execute, (encoded));
        vm.prank(caller);
        // All calls target the real bounded Gateway ABI; catch only its exact result, never fixture failures.
        // forge-lint: disable-next-line(low-level-calls)
        return address(GATEWAY).call(data);
    }

    // One small pool is checked after every action. Model counters never write production replay storage.
    // Every mismatch must abort immediately, including inside this fixed-size observation loop.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop)
    function _assertModel(Action action, uint256 poolIndex) private view {
        uint256 total = 0;
        for (uint256 index = 0; index < ids.length; index++) {
            bytes32 id = ids[index];
            uint256 count = successes[id];
            if (count > 1 || RECEIVER.callsByMessage(id) != count || GATEWAY.isMessageExecuted(id) != (count == 1)) {
                revert ModelMismatch(action, poolIndex, id);
            }
            if (count == 1 && RECEIVER.payloadHashByMessage(id) != payloadHashes[index]) revert ModelMismatch(action, poolIndex, id);
            total += count;
        }
        if (RECEIVER.calls() != total || validSuccesses != total) revert ModelMismatch(action, poolIndex, bytes32(0));
        _assertUnconsumed(EXPIRED_ID, action, poolIndex);
    }

    function _assertUnconsumed(bytes32 id, Action action, uint256 index) private view {
        if (GATEWAY.isMessageExecuted(id) || RECEIVER.callsByMessage(id) != 0) revert ModelMismatch(action, index, id);
    }

    function _authenticateAttack(Codec.Package memory pack) private view {
        uint256 authority = Certificate.context(pack.envelope.certificate).authorityEpoch;
        _authenticatePackage(pack, VALIDATORS, MERKLE, authority);
    }

    function _index(uint256 seed) private view returns (uint256) { return bound(seed, 0, packages.length - 1); }
    function _replayReason(bytes32 id) private pure returns (bytes memory) {
        return abi.encodeWithSelector(MessageReplayProtection.MessageAlreadyExecuted.selector, id);
    }
    function _sameBytes(bytes memory left, bytes memory right) private pure returns (bool) {
        if (left.length != right.length) return false;
        for (uint256 index = 0; index < left.length; index++) if (left[index] != right[index]) return false;
        return true;
    }
}
