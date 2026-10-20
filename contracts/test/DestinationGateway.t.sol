// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {stdError} from "forge-std/StdError.sol";
import {DestinationGateway} from "../src/DestinationGateway.sol";
import {ApplicationB} from "../src/ApplicationB.sol";
import {SourceGateway} from "../src/SourceGateway.sol";
import {RemoteGatewayRegistry} from "../src/RemoteGatewayRegistry.sol";
import {ValidatorSetRegistry} from "../src/ValidatorSetRegistry.sol";
import {PBFTCertificateVerifier} from "../src/PBFTCertificateVerifier.sol";
import {MerkleInclusionVerifier} from "../src/MerkleInclusionVerifier.sol";
import {MessageDomainVerifier} from "../src/MessageDomainVerifier.sol";
import {MessageReplayProtection} from "../src/MessageReplayProtection.sol";
import {IPBFTCertificateVerifier} from "../src/interfaces/IPBFTCertificateVerifier.sol";
import {MessageCodec} from "../src/MessageCodec.sol";
import {MessageMerkle} from "../src/MessageMerkle.sol";
import {DeliveryPackageCodec as Codec} from "../src/libraries/DeliveryPackageCodec.sol";
import {PBFTCertificateCodec as Certificate} from "../src/libraries/PBFTCertificateCodec.sol";
import {GatewayReceiverFixture} from "./mocks/GatewayReceiverFixture.sol";
import {MockSourceApplication} from "./mocks/MockSourceApplication.sol";

contract DestinationGatewayTest is Test {
    uint256 private constant SOURCE = 10011;
    uint256 private constant DESTINATION = 2001;
    uint256 private constant NOW = 2_000_000_000;
    uint256 private constant EPOCH = (1 << 200) + 23;
    uint256 private constant VIEW = 2;
    uint256 private constant INITIAL_AUTHORITY = 7;
    uint256 private constant CURRENT_AUTHORITY = 8;
    uint256 private constant COMMITTEE_SIZE = 4;
    uint256 private constant QUORUM = 3;
    uint256 private constant WORD = 32;
    uint256 private constant BATCH_BYTES_OFFSET_SLOT = 128;
    uint256 private constant BATCH_MESSAGE_IDS_OFFSET = WORD * 4;
    uint8 private constant UNSUPPORTED_MESSAGE_VERSION = 3;
    bytes1 private constant NONZERO_BYTE = 0x01;
    bytes1 private constant TRAILING_ZERO = 0x00;
    uint256 private constant PAYLOAD_LIMIT = 4096;
    uint256 private constant BATCH_LIMIT = 128;
    uint256 private constant PACKAGE_LIMIT = 11232;
    uint256 private constant LOCAL_BLOCK_GAS_LIMIT = 30_000_000;
    address private constant SOURCE_GATEWAY = address(0x1001);
    address private constant SUPPLIER = address(0x123456);
    address private constant SUBMITTER = address(0xABC);

    DestinationGateway private gateway;
    ApplicationB private application;
    GatewayReceiverFixture private receiver;
    RemoteGatewayRegistry private remote;
    ValidatorSetRegistry private validators;
    PBFTCertificateVerifier private certificateVerifier;
    MerkleInclusionVerifier private merkleVerifier;
    MessageDomainVerifier private domainVerifier;

    function setUp() public {
        vm.warp(NOW);
        remote = new RemoteGatewayRegistry(address(this));
        remote.setRemoteGateway(SOURCE, SOURCE_GATEWAY);
        validators = new ValidatorSetRegistry(address(this));
        validators.registerValidatorSet(INITIAL_AUTHORITY, _committee(INITIAL_AUTHORITY));
        validators.registerValidatorSet(CURRENT_AUTHORITY, _committee(CURRENT_AUTHORITY));
        certificateVerifier = new PBFTCertificateVerifier(address(validators));
        merkleVerifier = new MerkleInclusionVerifier();
        domainVerifier = new MessageDomainVerifier(address(remote), DESTINATION);
        gateway = new DestinationGateway(address(certificateVerifier), address(merkleVerifier), address(domainVerifier));
        application = new ApplicationB(address(gateway));
        receiver = new GatewayReceiverFixture();
        receiver.configure(gateway, false, "");
    }

    function testDependenciesAndSharedPolicy() public {
        assertEq(address(gateway.CERTIFICATE_VERIFIER()), address(certificateVerifier));
        assertEq(address(gateway.MERKLE_VERIFIER()), address(merkleVerifier));
        assertEq(address(gateway.DOMAIN_VERIFIER()), address(domainVerifier));
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory policy = vm.readFile(string.concat(vm.projectRoot(), "/../test-vectors/delivery-policy.json"));
        assertEq(gateway.MAX_PAYLOAD_BYTES(), vm.parseJsonUint(policy, ".maxPayloadBytes"));
        assertEq(gateway.MAX_BATCH_MESSAGES(), vm.parseJsonUint(policy, ".maxBatchMessages"));
        assertEq(gateway.MAX_PACKAGE_BYTES(), vm.parseJsonUint(policy, ".maxPackageBytes"));
        vm.expectRevert(abi.encodeWithSelector(DestinationGateway.InvalidVerifierDependency.selector, address(0)));
        new DestinationGateway(address(0), address(merkleVerifier), address(domainVerifier));
        vm.expectRevert(abi.encodeWithSelector(DestinationGateway.InvalidVerifierDependency.selector, SUBMITTER));
        new DestinationGateway(address(certificateVerifier), SUBMITTER, address(domainVerifier));
        vm.expectRevert(abi.encodeWithSelector(DestinationGateway.InvalidVerifierDependency.selector, address(0)));
        new DestinationGateway(address(certificateVerifier), address(merkleVerifier), address(0));
    }

    function testPermissionlessAtomicBusinessGrantAndEvents() public {
        Codec.Package memory pack = _package(address(application), abi.encode(uint8(1), uint8(1), SUPPLIER), 1, Certificate.EPOCH_VERSION);
        assertFalse(application.isVerifiedSupplier(SUPPLIER));
        vm.recordLogs();
        vm.prank(SUBMITTER);
        gateway.execute(_encode(pack));
        assertTrue(gateway.isMessageExecuted(pack.message.messageId));
        assertTrue(application.isVerifiedSupplier(SUPPLIER));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].emitter, address(application));
        assertEq(logs[0].topics[0], ApplicationB.VerifiedSupplierGranted.selector);
        assertEq(logs[0].topics[1], pack.message.messageId);
        assertEq(logs[1].emitter, address(gateway));
        assertEq(logs[1].topics[0], DestinationGateway.CrossChainMessageExecuted.selector);
        assertEq(logs[1].topics[1], pack.message.messageId);
        assertEq(logs[1].topics[2], bytes32(SOURCE));
        assertEq(logs[1].topics[3], bytes32(uint256(uint160(address(application)))));
        assertEq(abi.decode(logs[1].data, (bytes32)), pack.batch.batchId);
        vm.expectRevert(abi.encodeWithSelector(MessageReplayProtection.MessageAlreadyExecuted.selector, pack.message.messageId));
        vm.prank(address(0xDEF));
        gateway.execute(_encode(pack));
    }

    function testCrossChainSafetyUnauthorizedSelfConsistentRootCannotExecute() public {
        Codec.Package memory pack = _safetyBaseline();
        bytes memory authorizedCertificate = pack.envelope.certificate;
        bytes32 authorizedRoot = pack.envelope.messageRoot;
        // Change only the other member, retaining the exact target message and its valid business intent.
        pack.batch.messageIds[1] = bytes32(uint256(2));
        _reauthorizeSafetyPackage(pack);
        assertNotEq(pack.envelope.messageRoot, authorizedRoot);
        _assertSafetyMembership(pack);
        // The original commitment never authorized this otherwise self-consistent alternate tree.
        pack.envelope.certificate = authorizedCertificate;
        _rejectSafety(pack, abi.encodeWithSelector(PBFTCertificateVerifier.ContextMismatch.selector));
        pack = _package(address(application), abi.encode(uint8(1), uint8(1), SUPPLIER), 2, Certificate.EPOCH_VERSION);
        pack.envelope.certificate = authorizedCertificate;
        assertEq(pack.envelope.messageRoot, authorizedRoot);
        _assertSafetySuccess(pack);
    }

    function testCrossChainSafetyWrongSiblingCannotConsumeAndOriginalProofStillExecutes() public {
        Codec.Package memory pack = _safetyBaseline();
        bytes32 sibling = pack.envelope.siblings[0];
        pack.envelope.siblings[0] = bytes32(uint256(sibling) ^ 1);
        bytes32 alteredRoot = MessageMerkle.hashNode(
            MessageMerkle.computeLeaf(pack.batch.batchId, 0, pack.message.messageId), pack.envelope.siblings[0]
        );
        _rejectSafety(pack, abi.encodeWithSelector(
            MessageMerkle.MerkleRootMismatch.selector, pack.envelope.messageRoot, alteredRoot
        ));
        pack.envelope.siblings[0] = sibling;
        _assertSafetySuccess(pack);
    }

    function testCrossChainSafetyTwoValidSignersCannotAuthorizeThreeOfFourQuorum() public {
        Codec.Package memory pack = _safetyBaseline();
        bytes memory authorizedCertificate = pack.envelope.certificate;
        (uint8 version, bytes memory statement, bytes32 digest, Certificate.Evidence[] memory verifiedVotes) =
            abi.decode(authorizedCertificate, (uint8, bytes, bytes32, Certificate.Evidence[]));
        assertEq(verifiedVotes.length, QUORUM);
        assertNotEq(verifiedVotes[0].voterIdentity, verifiedVotes[1].voterIdentity);
        // Both signatures are copied byte-for-byte from the already authenticated three-signer QC.
        Certificate.Evidence[] memory insufficient = new Certificate.Evidence[](2);
        insufficient[0] = verifiedVotes[0];
        insufficient[1] = verifiedVotes[1];
        pack.envelope.certificate = abi.encode(version, statement, digest, insufficient);
        _assertSafetyMembership(pack);
        _rejectSafety(pack, abi.encodeWithSelector(Certificate.InvalidEvidenceCount.selector, 2));
        pack.envelope.certificate = authorizedCertificate;
        _assertSafetySuccess(pack);
    }

    function testCrossChainSafetyDuplicateAuthenticatedBytesRejectEverySubmitter() public {
        Codec.Package memory pack = _safetyBaseline();
        bytes memory originalBytes = _encode(pack);
        _assertSafetySuccess(pack);
        _assertSafetyCryptography(pack);
        bytes memory reason = abi.encodeWithSelector(
            MessageReplayProtection.MessageAlreadyExecuted.selector, pack.message.messageId
        );
        _rejectSafetyFrom(pack, reason, SUBMITTER);
        _rejectSafetyFrom(pack, reason, address(0xDEF));
        assertEq(_encode(pack), originalBytes);
        assertTrue(gateway.isMessageExecuted(pack.message.messageId));
        assertTrue(application.isVerifiedSupplier(SUPPLIER));
    }

    function testCrossChainSafetySelfConsistentWrongDestinationDomainCannotExecute() public {
        Codec.Package memory valid = _safetyBaseline();
        Codec.Package memory changed = _package(address(application), valid.message.payload, 2, Certificate.EPOCH_VERSION);
        changed.message.destinationDomain = DESTINATION + 1;
        _reauthorizeSafetyPackage(changed);
        assertNotEq(changed.message.messageId, valid.message.messageId);
        _assertSafetyCryptography(changed);
        _rejectSafety(changed, abi.encodeWithSelector(
            MessageDomainVerifier.InvalidDestinationDomain.selector, DESTINATION, DESTINATION + 1
        ));
        _assertSafetySuccess(valid);
        assertFalse(gateway.isMessageExecuted(changed.message.messageId));
    }

    function testCrossChainSafetyFullWidthDestinationCannotAliasLocalDomain() public {
        Codec.Package memory valid = _safetyBaseline();
        Codec.Package memory changed = _package(address(application), valid.message.payload, 2, Certificate.EPOCH_VERSION);
        changed.message.destinationDomain = (uint256(1) << 200) + DESTINATION;
        _reauthorizeSafetyPackage(changed);
        assertNotEq(changed.message.messageId, valid.message.messageId);
        _assertSafetyCryptography(changed);
        _rejectSafety(changed, abi.encodeWithSelector(
            MessageDomainVerifier.InvalidDestinationDomain.selector, DESTINATION, changed.message.destinationDomain
        ));
        _assertSafetySuccess(valid);
    }

    function testCrossChainSafetySelfConsistentWrongDestinationGatewayCannotExecute() public {
        Codec.Package memory valid = _safetyBaseline();
        Codec.Package memory changed = _package(address(application), valid.message.payload, 2, Certificate.EPOCH_VERSION);
        changed.message.destinationGateway = SUBMITTER;
        _reauthorizeSafetyPackage(changed);
        assertNotEq(changed.message.messageId, valid.message.messageId);
        _assertSafetyCryptography(changed);
        _rejectSafety(changed, abi.encodeWithSelector(
            MessageDomainVerifier.DestinationGatewayMismatch.selector, address(gateway), SUBMITTER
        ));
        _assertSafetySuccess(valid);
    }

    function testCrossChainSafetySelfConsistentUntrustedSourceGatewayCannotExecute() public {
        Codec.Package memory valid = _safetyBaseline();
        Codec.Package memory changed = _package(address(application), valid.message.payload, 2, Certificate.EPOCH_VERSION);
        changed.message.sourceGateway = SUBMITTER;
        _reauthorizeSafetyPackage(changed);
        assertNotEq(changed.message.messageId, valid.message.messageId);
        _assertSafetyCryptography(changed);
        _rejectSafety(changed, abi.encodeWithSelector(
            RemoteGatewayRegistry.UntrustedRemoteGateway.selector, SOURCE, SUBMITTER, SOURCE_GATEWAY
        ));
        assertEq(remote.trustedRemoteGateway(SOURCE), SOURCE_GATEWAY);
        _assertSafetySuccess(valid);
    }

    function testCrossChainSafetySelfConsistentUnknownSourceDomainCannotExecute() public {
        Codec.Package memory valid = _safetyBaseline();
        Codec.Package memory changed = _package(address(application), valid.message.payload, 2, Certificate.EPOCH_VERSION);
        changed.message.sourceDomain = SOURCE + 1;
        _reauthorizeSafetyPackage(changed);
        assertNotEq(changed.message.messageId, valid.message.messageId);
        _assertSafetyCryptography(changed);
        _rejectSafety(changed, abi.encodeWithSelector(RemoteGatewayRegistry.UnknownSourceDomain.selector, SOURCE + 1));
        assertEq(remote.trustedRemoteGateway(SOURCE + 1), address(0));
        _assertSafetySuccess(valid);
    }

    function testCrossChainSafetyInvalidReceiverCannotRedirectBusinessExecution() public {
        Codec.Package memory valid = _safetyBaseline();
        Codec.Package memory changed = _package(address(0), valid.message.payload, 2, Certificate.EPOCH_VERSION);
        _reauthorizeSafetyPackage(changed);
        assertNotEq(changed.message.messageId, valid.message.messageId);
        _assertSafetyCryptography(changed);
        _rejectSafety(changed, abi.encodeWithSelector(MessageDomainVerifier.InvalidDestinationReceiver.selector));
        changed = _package(SUBMITTER, valid.message.payload, 2, Certificate.EPOCH_VERSION);
        _reauthorizeSafetyPackage(changed);
        assertNotEq(changed.message.messageId, valid.message.messageId);
        _assertSafetyCryptography(changed);
        _rejectSafety(changed, abi.encodeWithSelector(DestinationGateway.InvalidDestinationReceiver.selector, SUBMITTER));
        _assertSafetySuccess(valid);
    }

    // Each version signs its original frozen hash schema and resolves its original historical authority.
    // forge-lint: disable-next-item(calls-loop)
    function testLegacyAndRotatedCertificatesThroughComposition() public {
        for (uint8 version = Certificate.LEGACY_VERSION; version <= Certificate.EPOCH_VERSION; version++) {
            Codec.Package memory pack = _package(address(receiver), "", version, version);
            gateway.execute(_encode(pack));
            assertTrue(gateway.isMessageExecuted(pack.message.messageId));
        }
        assertEq(receiver.calls(), Certificate.EPOCH_VERSION - Certificate.LEGACY_VERSION + 1);
    }

    function testCompleteFrozenTransportThroughActualSolidityDecoder() public {
        // Read-only golden evidence. No Solidity or verification-time generator rewrites its expected bytes.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        string memory vector = vm.readFile(string.concat(vm.projectRoot(), "/../test-vectors/destination-transport.json"));
        address target = vm.parseJsonAddress(vector, ".expectedTarget");
        address targetReceiver = vm.parseJsonAddress(vector, ".package.message.destinationReceiver");
        bytes32 messageId = vm.parseJsonBytes32(vector, ".package.message.messageId");
        bytes memory inner = vm.parseJsonBytes(vector, ".canonicalPackageBytes");
        bytes memory callData = vm.parseJsonBytes(vector, ".gatewayCalldata");
        assertEq(callData, abi.encodeCall(DestinationGateway.execute, (inner)));
        remote.setRemoteGateway(SOURCE, vm.parseJsonAddress(vector, ".package.message.sourceGateway"));
        // Unit-only fixed-address deployment makes the frozen authenticated targets executable.
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.etch(target, address(gateway).code);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.etch(targetReceiver, address(receiver).code);
        GatewayReceiverFixture(targetReceiver).configure(DestinationGateway(target), false, "");
        DestinationGateway(target).execute(inner);
        assertTrue(DestinationGateway(target).isMessageExecuted(messageId));
        assertEq(GatewayReceiverFixture(targetReceiver).calls(), 1);
        assertTrue(GatewayReceiverFixture(targetReceiver).observedConsumed());
    }

    function testReceiverRollbackThenSameMessageRetry() public {
        Codec.Package memory pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        receiver.configure(gateway, true, "");
        _reject(pack, abi.encodeWithSelector(GatewayReceiverFixture.ReceiverRejected.selector));
        assertEq(receiver.calls(), 0);
        receiver.configure(gateway, false, "");
        gateway.execute(_encode(pack));
        assertTrue(receiver.observedConsumed());
        assertEq(receiver.calls(), 1);
    }

    function testDifferentMessageBusinessRejectionRollsBackConsumption() public {
        bytes memory payload = abi.encode(uint8(1), uint8(1), SUPPLIER);
        Codec.Package memory first = _package(address(application), payload, 1, Certificate.EPOCH_VERSION);
        Codec.Package memory second = _package(address(application), payload, 2, Certificate.EPOCH_VERSION);
        gateway.execute(_encode(first));
        _reject(second, abi.encodeWithSelector(ApplicationB.AlreadyVerifiedSupplier.selector, SUPPLIER));
        assertTrue(gateway.isMessageExecuted(first.message.messageId));
        assertTrue(application.isVerifiedSupplier(SUPPLIER));
    }

    function testSameMessageReentryRejectedAfterConsumption() public {
        Codec.Package memory pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        receiver.configure(gateway, false, abi.encodeCall(DestinationGateway.execute, (_encode(pack))));
        gateway.execute(_encode(pack));
        assertTrue(receiver.observedConsumed());
        assertFalse(receiver.nestedSuccess());
        assertEq(receiver.nestedResult(), abi.encodeWithSelector(MessageReplayProtection.MessageAlreadyExecuted.selector, pack.message.messageId));
        assertEq(receiver.calls(), 1);
    }

    function testDifferentValidMessageMayExecuteDuringCallback() public {
        Codec.Package memory first = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        Codec.Package memory second = _package(address(application), abi.encode(uint8(1), uint8(1), SUPPLIER), 2, Certificate.EPOCH_VERSION);
        receiver.configure(gateway, false, abi.encodeCall(DestinationGateway.execute, (_encode(second))));
        gateway.execute(_encode(first));
        assertTrue(receiver.nestedSuccess());
        assertTrue(gateway.isMessageExecuted(second.message.messageId));
        assertTrue(application.isVerifiedSupplier(SUPPLIER));
    }

    function testInvalidCertificateAndRootFailBeforeConsumption() public {
        Codec.Package memory pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        pack.envelope.messageRoot = bytes32(uint256(pack.envelope.messageRoot) ^ 1);
        _reject(pack, abi.encodeWithSelector(PBFTCertificateVerifier.ContextMismatch.selector));
        pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        _putWord(pack.envelope.certificate, WORD * 2, 1);
        _reject(pack, abi.encodeWithSelector(PBFTCertificateVerifier.QuorumCertificateDigestMismatch.selector));
    }

    function testRelabeledCurrentAuthorityAndLegacyWrongAnchorReject() public {
        Codec.Package memory pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        // Only relabel the signed authority. The original committee/signatures cannot become epoch 7.
        _putWord(pack.envelope.certificate, WORD * 13, INITIAL_AUTHORITY);
        _reject(pack, abi.encodeWithSelector(PBFTCertificateVerifier.CommitteeDigestMismatch.selector));
        pack = _package(address(receiver), "", 1, Certificate.LEGACY_VERSION);
        ValidatorSetRegistry otherRegistry = new ValidatorSetRegistry(address(this));
        otherRegistry.registerValidatorSet(CURRENT_AUTHORITY, _committee(CURRENT_AUTHORITY));
        PBFTCertificateVerifier otherVerifier = new PBFTCertificateVerifier(address(otherRegistry));
        DestinationGateway otherGateway = new DestinationGateway(address(otherVerifier), address(merkleVerifier), address(domainVerifier));
        vm.expectRevert(abi.encodeWithSelector(PBFTCertificateVerifier.CommitteeDigestMismatch.selector));
        otherGateway.execute(_encode(pack));
        assertFalse(otherGateway.isMessageExecuted(pack.message.messageId));
    }

    function testInvalidMerklePathAndRehashedSubstitution() public {
        Codec.Package memory pack = _package(address(receiver), "", 2, Certificate.EPOCH_VERSION);
        pack.envelope.siblings[0] = bytes32(uint256(pack.envelope.siblings[0]) ^ 1);
        bytes32 alteredRoot = MessageMerkle.hashNode(MessageMerkle.computeLeaf(pack.batch.batchId, 0, pack.message.messageId), pack.envelope.siblings[0]);
        _reject(pack, abi.encodeWithSelector(MessageMerkle.MerkleRootMismatch.selector, pack.envelope.messageRoot, alteredRoot));
        pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        bytes32 original = pack.message.messageId;
        pack.message.destinationReceiver = SUBMITTER;
        pack.message.messageId = MessageCodec.computeMessageId(Codec.canonicalMessage(pack.message));
        _reject(pack, abi.encodeWithSelector(MerkleInclusionVerifier.MemberMessageIdMismatch.selector, 0, pack.message.messageId, original));
    }

    function testPayloadAndReceiverIdentityCannotBeSubstituted() public {
        Codec.Package memory pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        pack.message.payload = abi.encodePacked(NONZERO_BYTE);
        _reject(pack, abi.encodeWithSelector(MessageDomainVerifier.PayloadHashMismatch.selector, pack.message.payloadHash, keccak256(hex"01")));
        pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        pack.message.destinationReceiver = SUBMITTER;
        bytes32 changed = MessageCodec.computeMessageId(Codec.canonicalMessage(pack.message));
        _reject(pack, abi.encodeWithSelector(MessageDomainVerifier.MessageIdMismatch.selector, pack.message.messageId, changed));
    }

    function testCurrentRemoteAuthorityAndExactDestination() public {
        Codec.Package memory pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        remote.setRemoteGateway(SOURCE, SUBMITTER);
        _reject(pack, abi.encodeWithSelector(RemoteGatewayRegistry.UntrustedRemoteGateway.selector, SOURCE, SOURCE_GATEWAY, SUBMITTER));
        remote.setRemoteGateway(SOURCE, SOURCE_GATEWAY);
        pack.message.destinationDomain++;
        _reject(pack, abi.encodeWithSelector(MessageDomainVerifier.InvalidDestinationDomain.selector, DESTINATION, DESTINATION + 1));
        pack.message.destinationDomain = DESTINATION;
        pack.message.destinationGateway = SUBMITTER;
        _reject(pack, abi.encodeWithSelector(MessageDomainVerifier.DestinationGatewayMismatch.selector, address(gateway), SUBMITTER));
    }

    function testAuthenticExpiryAndCodeFreeReceiverNeverConsume() public {
        Codec.Package memory pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        vm.warp(pack.message.deadline);
        _reject(pack, abi.encodeWithSelector(MessageDomainVerifier.MessageExpired.selector, pack.message.deadline, pack.message.deadline));
        vm.warp(NOW);
        pack = _package(SUBMITTER, "", 1, Certificate.EPOCH_VERSION);
        _reject(pack, abi.encodeWithSelector(DestinationGateway.InvalidDestinationReceiver.selector, SUBMITTER));
    }

    function testPayloadLimitMinusOneAndAtLimit() public {
        gateway.execute(_encode(_package(address(receiver), new bytes(PAYLOAD_LIMIT - 1), 1, Certificate.EPOCH_VERSION)));
        gateway.execute(_encode(_package(address(receiver), new bytes(PAYLOAD_LIMIT), 1, Certificate.EPOCH_VERSION)));
        Codec.Package memory pack = _package(address(receiver), new bytes(PAYLOAD_LIMIT + 1), 1, Certificate.EPOCH_VERSION);
        _reject(pack, abi.encodeWithSelector(Codec.PayloadLimitExceeded.selector, PAYLOAD_LIMIT + 1, PAYLOAD_LIMIT));
    }

    function testBatchLimitMinusOneAndAtLimit() public {
        gateway.execute(_encode(_package(address(receiver), "", BATCH_LIMIT - 1, Certificate.EPOCH_VERSION)));
        gateway.execute(_encode(_package(address(receiver), "", BATCH_LIMIT, Certificate.EPOCH_VERSION)));
        Codec.Package memory pack = _package(address(receiver), "", BATCH_LIMIT + 1, Certificate.EPOCH_VERSION);
        _reject(pack, abi.encodeWithSelector(Codec.BatchLimitExceeded.selector, BATCH_LIMIT + 1, BATCH_LIMIT));
    }

    function testMaximumCanonicalPackageLength() public {
        Codec.Package memory pack = _package(address(receiver), new bytes(PAYLOAD_LIMIT), BATCH_LIMIT, Certificate.EPOCH_VERSION);
        pack.envelope.deliveryJobId = string(new bytes(192));
        bytes memory encoded = _encode(pack);
        assertEq(encoded.length, PACKAGE_LIMIT);
        uint256 gasBefore = gasleft();
        gateway.execute(encoded);
        assertLt(gasBefore - gasleft(), LOCAL_BLOCK_GAS_LIMIT, "maximum package must fit the documented local block budget");
        assertTrue(gateway.isMessageExecuted(pack.message.messageId));
    }

    function testEnvelopeVersionDomainMembershipAndCanonicality() public {
        Codec.Package memory pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        pack.envelope.version = 2;
        _reject(pack, abi.encodeWithSelector(Codec.UnsupportedTransportVersion.selector, 2));
        pack.envelope.version = 1;
        pack.envelope.domain = "wrong";
        _reject(pack, abi.encodeWithSelector(Codec.InvalidTransportDomain.selector));
        pack.envelope.domain = "CrossChainDeliveryPackage";
        pack.envelope.leafCount++;
        _reject(pack, abi.encodeWithSelector(Codec.InvalidPackageMembership.selector));
        pack.envelope.leafCount--;
        bytes memory encoded = bytes.concat(_encode(pack), abi.encode(uint256(0)));
        vm.expectRevert(Codec.InvalidPackageEncoding.selector);
        gateway.execute(encoded);
        pack.envelope.messageBytes = bytes.concat(_messageBytes(pack.message), TRAILING_ZERO);
        vm.expectRevert(Codec.InvalidPackageEncoding.selector);
        gateway.execute(_envelopeBytes(pack.envelope));
    }

    function testMalformedEnvelopeOffsetRejectsWithEmptyData() public {
        Codec.Package memory pack = _package(address(application), abi.encode(uint8(1), uint8(1), SUPPLIER), 1, Certificate.EPOCH_VERSION);
        bytes memory encoded = _encode(pack);
        _putWord(encoded, 0, type(uint256).max);
        assertFalse(gateway.isMessageExecuted(pack.message.messageId));
        assertFalse(application.isVerifiedSupplier(SUPPLIER));
        // An out-of-range dynamic offset is rejected by the ABI decoder with empty revert data.
        _rejectEncoded(encoded, pack.message.messageId, bytes(""));
    }

    function testImpossibleBatchArrayLengthRejectsWithMemoryPanic() public {
        Codec.Package memory pack = _package(address(application), abi.encode(uint8(1), uint8(1), SUPPLIER), 1, Certificate.EPOCH_VERSION);
        bytes memory encoded = _encode(pack);
        // Locate batchBytes through the existing outer ABI offset, then corrupt its array length.
        uint256 batchOffset;
        // Test-only bounded word read from the correctly encoded fixture head.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") { batchOffset := mload(add(add(encoded, WORD), BATCH_BYTES_OFFSET_SLOT)) }
        _putWord(encoded, batchOffset + WORD + BATCH_MESSAGE_IDS_OFFSET, type(uint256).max);
        assertFalse(gateway.isMessageExecuted(pack.message.messageId));
        assertFalse(application.isVerifiedSupplier(SUPPLIER));
        // An impossible dynamic-array allocation returns the complete Panic(0x41) payload.
        _rejectEncoded(encoded, pack.message.messageId, stdError.memOverflowError);
    }

    function testUnsupportedMessageVersionCannotConsume() public {
        Codec.Package memory pack = _package(address(receiver), "", 1, Certificate.EPOCH_VERSION);
        pack.message.version = UNSUPPORTED_MESSAGE_VERSION;
        _reject(pack, abi.encodeWithSelector(MessageDomainVerifier.UnsupportedMessageVersion.selector, UNSUPPORTED_MESSAGE_VERSION));
    }

    function testOversizedAndTruncatedEnvelopeAndNonzeroValue() public {
        vm.expectRevert(abi.encodeWithSelector(Codec.PackageLimitExceeded.selector, PACKAGE_LIMIT + 1, PACKAGE_LIMIT));
        gateway.execute(new bytes(PACKAGE_LIMIT + 1));
        // The ABI decoder's empty-data revert is precise for an empty/truncated head.
        vm.expectRevert(bytes(""));
        gateway.execute(abi.encodePacked(NONZERO_BYTE));
        bytes memory data = abi.encodeCall(DestinationGateway.execute, (_encode(_package(address(receiver), "", 1, Certificate.EPOCH_VERSION))));
        vm.deal(address(this), 1);
        // Intentionally test the nonpayable dispatcher and malformed outer ABI via low-level calls.
        // This test sends one wei only to the locally deployed nonpayable gateway and asserts rejection.
        // forge-lint: disable-next-line(low-level-calls, arbitrary-send-eth)
        (bool success, bytes memory result) = address(gateway).call{value: 1}(data);
        assertFalse(success); assertEq(result.length, 0);
        // forge-lint: disable-next-line(low-level-calls)
        (success, result) = address(gateway).call(bytes.concat(data, TRAILING_ZERO));
        assertFalse(success); assertEq(result, abi.encodeWithSelector(DestinationGateway.InvalidExecutionEncoding.selector));
    }

    function testSourcePayloadLimitBeforeNonceConsumption() public {
        SourceGateway source = new SourceGateway(address(this));
        MockSourceApplication app = new MockSourceApplication();
        source.setSourceApplicationAuthorization(address(app), true);
        vm.prank(address(app));
        (bytes32 id, uint256 sentNonce) = source.sendMessage(DESTINATION, address(gateway), address(receiver), new bytes(PAYLOAD_LIMIT - 1), NOW + 1);
        assertTrue(id != bytes32(0));
        assertEq(sentNonce, 1);
        vm.prank(address(app));
        (id, sentNonce) = source.sendMessage(DESTINATION, address(gateway), address(receiver), new bytes(PAYLOAD_LIMIT), NOW + 1);
        assertTrue(id != bytes32(0));
        assertEq(sentNonce, 2);
        uint256 nonce = source.nextNonce();
        assertEq(nonce, sentNonce + 1);
        vm.expectRevert(abi.encodeWithSelector(SourceGateway.PayloadLimitExceeded.selector, PAYLOAD_LIMIT + 1, PAYLOAD_LIMIT));
        vm.prank(address(app));
        // The VM requires the exact revert; this failing call cannot return a nonce or ID.
        // forge-lint: disable-next-line(unused-return)
        source.sendMessage(DESTINATION, address(gateway), address(receiver), new bytes(PAYLOAD_LIMIT + 1), NOW + 1);
        assertEq(source.nextNonce(), nonce);
    }

    function _reject(Codec.Package memory pack, bytes memory reason) private {
        _rejectEncoded(_encode(pack), pack.message.messageId, reason);
    }

    function _rejectEncoded(bytes memory encoded, bytes32 messageId, bytes memory reason) private {
        bool supplierBefore = application.isVerifiedSupplier(SUPPLIER);
        vm.recordLogs();
        vm.expectRevert(reason);
        gateway.execute(encoded);
        assertFalse(gateway.isMessageExecuted(messageId));
        assertEq(application.isVerifiedSupplier(SUPPLIER), supplierBefore);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function _safetyBaseline() private returns (Codec.Package memory pack) {
        pack = _package(address(application), abi.encode(uint8(1), uint8(1), SUPPLIER), 2, Certificate.EPOCH_VERSION);
        pack.envelope.certificate = _certificate(pack, Certificate.EPOCH_VERSION, QUORUM);
        // Prove the complete fixture can execute before attacking one boundary, then restore this test's own EVM state.
        uint256 snapshot = vm.snapshotState();
        _assertSafetySuccess(pack);
        assertTrue(vm.revertToStateAndDelete(snapshot));
        assertFalse(gateway.isMessageExecuted(pack.message.messageId));
        assertFalse(application.isVerifiedSupplier(SUPPLIER));
    }

    function _assertSafetySuccess(Codec.Package memory pack) private {
        assertFalse(gateway.isMessageExecuted(pack.message.messageId));
        assertFalse(application.isVerifiedSupplier(SUPPLIER));
        _assertSafetyCryptography(pack);
        vm.recordLogs();
        vm.prank(SUBMITTER);
        gateway.execute(_encode(pack));
        assertTrue(gateway.isMessageExecuted(pack.message.messageId));
        assertTrue(application.isVerifiedSupplier(SUPPLIER));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].emitter, address(application));
        assertEq(logs[0].topics[0], ApplicationB.VerifiedSupplierGranted.selector);
        assertEq(logs[0].topics[1], pack.message.messageId);
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(SUPPLIER))));
        assertEq(logs[1].emitter, address(gateway));
        assertEq(logs[1].topics[0], DestinationGateway.CrossChainMessageExecuted.selector);
        assertEq(logs[1].topics[1], pack.message.messageId);
        assertEq(abi.decode(logs[1].data, (bytes32)), pack.batch.batchId);
    }

    function _rejectSafety(Codec.Package memory pack, bytes memory reason) private {
        assertFalse(gateway.isMessageExecuted(pack.message.messageId));
        assertFalse(application.isVerifiedSupplier(SUPPLIER));
        _rejectSafetyFrom(pack, reason, SUBMITTER);
        _rejectSafetyFrom(pack, reason, address(0xDEF));
        assertFalse(gateway.isMessageExecuted(pack.message.messageId));
    }

    function _rejectSafetyFrom(Codec.Package memory pack, bytes memory reason, address submitter) private {
        bool consumedBefore = gateway.isMessageExecuted(pack.message.messageId);
        bool supplierBefore = application.isVerifiedSupplier(SUPPLIER);
        vm.recordLogs();
        vm.expectRevert(reason);
        vm.prank(submitter);
        gateway.execute(_encode(pack));
        assertEq(gateway.isMessageExecuted(pack.message.messageId), consumedBefore);
        assertEq(application.isVerifiedSupplier(SUPPLIER), supplierBefore);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function _assertSafetyCryptography(Codec.Package memory pack) private view {
        assertEq(MessageCodec.computeMessageId(Codec.canonicalMessage(pack.message)), pack.message.messageId);
        IPBFTCertificateVerifier.ExpectedContext memory context = Certificate.context(pack.envelope.certificate);
        context.sourceDomain = pack.message.sourceDomain;
        context.sourceGateway = pack.message.sourceGateway;
        context.batchEpoch = pack.batch.epoch;
        context.batchId = pack.batch.batchId;
        context.messageRoot = pack.envelope.messageRoot;
        assertTrue(certificateVerifier.verifyCertificate(pack.envelope.certificate, context));
        _assertSafetyMembership(pack);
    }

    function _assertSafetyMembership(Codec.Package memory pack) private view {
        MerkleInclusionVerifier.BatchContext memory context = MerkleInclusionVerifier.BatchContext({
            version: pack.batch.version, sourceDomain: pack.message.sourceDomain, sourceGateway: pack.message.sourceGateway,
            epoch: pack.batch.epoch, batchId: pack.batch.batchId
        });
        MessageMerkle.Proof memory proof = MessageMerkle.Proof({
            batchId: pack.batch.batchId, messageId: pack.message.messageId, index: pack.envelope.messageIndex,
            leafCount: pack.envelope.leafCount, siblings: pack.envelope.siblings
        });
        assertTrue(merkleVerifier.verifyInclusion(context, pack.envelope.messageRoot, pack.message.messageId,
            pack.envelope.messageIndex, pack.batch.messageIds, proof));
    }

    function _reauthorizeSafetyPackage(Codec.Package memory pack) private view {
        pack.message.messageId = MessageCodec.computeMessageId(Codec.canonicalMessage(pack.message));
        pack.batch.messageIds[0] = pack.message.messageId;
        pack.batch.batchId = merkleVerifier.computeBatchId(pack.batch.version, pack.message.sourceDomain,
            pack.message.sourceGateway, pack.batch.epoch, pack.batch.messageIds);
        (pack.envelope.messageRoot, pack.envelope.siblings) = _tree(pack.batch.batchId, pack.batch.messageIds);
        // TEST-ONLY signatures exercise the real verifier; no live validator signs any altered message/root.
        pack.envelope.certificate = _certificate(pack, Certificate.EPOCH_VERSION, QUORUM);
    }

    // Fixture payload hashing stays explicit and independently readable beside the canonical identity.
    // The three-version test deliberately builds independent bounded fixtures and calls the real batch-ID verifier.
    // forge-lint: disable-next-item(asm-keccak256, calls-loop)
    function _package(address target, bytes memory payload, uint256 count, uint8 qcVersion)
        private view returns (Codec.Package memory pack)
    {
        pack.message.version = 2;
        pack.message.sourceDomain = SOURCE;
        pack.message.sourceGateway = SOURCE_GATEWAY;
        pack.message.sourceSender = address(0x1002);
        pack.message.destinationDomain = DESTINATION;
        pack.message.destinationGateway = address(gateway);
        pack.message.destinationReceiver = target;
        pack.message.nonce = count;
        pack.message.payload = payload;
        pack.message.payloadHash = keccak256(payload);
        pack.message.deadline = NOW + 3600;
        pack.message.messageId = MessageCodec.computeMessageId(Codec.canonicalMessage(pack.message));
        bytes32[] memory ids = new bytes32[](count);
        ids[0] = pack.message.messageId;
        for (uint256 index = 1; index < count; index++) ids[index] = bytes32(index);
        pack.batch = Codec.Batch({version: 1, epoch: EPOCH, batchId: bytes32(0), messageIds: ids});
        pack.batch.batchId = merkleVerifier.computeBatchId(1, SOURCE, SOURCE_GATEWAY, EPOCH, ids);
        (bytes32 root, bytes32[] memory siblings) = _tree(pack.batch.batchId, ids);
        pack.envelope.domain = "CrossChainDeliveryPackage";
        pack.envelope.version = 1;
        pack.envelope.deliveryJobId = "fixture";
        pack.envelope.leafCount = count;
        pack.envelope.messageRoot = root;
        pack.envelope.siblings = siblings;
        pack.envelope.certificate = _certificate(pack, qcVersion,
            qcVersion == Certificate.EPOCH_VERSION ? COMMITTEE_SIZE : QUORUM);
    }

    function _encode(Codec.Package memory pack) private pure returns (bytes memory) {
        pack.envelope.messageBytes = _messageBytes(pack.message);
        pack.envelope.batchBytes = abi.encode(pack.batch.version, pack.batch.epoch, pack.batch.batchId, pack.batch.messageIds);
        return _envelopeBytes(pack.envelope);
    }

    function _messageBytes(Codec.WireMessage memory m) private pure returns (bytes memory) {
        // Strip only the dynamic tuple's outer offset, preserving the frozen flat argument list.
        return _flat(abi.encode(m));
    }

    function _envelopeBytes(Codec.Envelope memory envelope) private pure returns (bytes memory) {
        return _flat(abi.encode(envelope));
    }

    // Copying each version's ABI fixture requires its own bounded memory buffer inside the version test loop.
    // forge-lint: disable-next-item(calls-loop)
    function _flat(bytes memory tuple) private pure returns (bytes memory flat) {
        flat = new bytes(tuple.length - WORD);
        for (uint256 index = 0; index < flat.length; index++) flat[index] = tuple[index + WORD];
    }

    // A bounded fixture tree reuses the unchanged pure leaf/node primitives at each level.
    // forge-lint: disable-next-item(calls-loop)
    function _tree(bytes32 batchId, bytes32[] memory ids) private pure returns (bytes32, bytes32[] memory siblings) {
        uint256 depth = 0;
        for (uint256 width = ids.length; width > 1; width = (width + 1) / 2) depth++;
        siblings = new bytes32[](depth);
        bytes32[] memory nodes = new bytes32[](ids.length);
        for (uint256 index = 0; index < ids.length; index++) nodes[index] = MessageMerkle.computeLeaf(batchId, index, ids[index]);
        uint256 length = nodes.length;
        for (uint256 level = 0; length > 1; level++) {
            siblings[level] = nodes[1];
            for (uint256 index = 0; index < length; index += 2) {
                nodes[index / 2] = MessageMerkle.hashNode(nodes[index], nodes[index + 1 < length ? index + 1 : index]);
            }
            length = (length + 1) / 2;
        }
        return (nodes[0], siblings);
    }

    // VM signing is unit evidence only. The root positive path uses the existing real validator processes.
    // forge-lint: disable-next-item(calls-loop)
    function _committee(uint256 authority) private pure returns (address[COMMITTEE_SIZE] memory members) {
        for (uint256 index = 0; index < COMMITTEE_SIZE; index++) members[index] = vm.addr(index + (authority == INITIAL_AUTHORITY ? 1 : 2));
        for (uint256 index = 1; index < COMMITTEE_SIZE; index++) {
            for (uint256 prior = index; prior > 0 && uint160(members[prior - 1]) > uint160(members[prior]); prior--) {
                (members[prior - 1], members[prior]) = (members[prior], members[prior - 1]);
            }
        }
    }

    // The three original PBFT schemas are intentionally explicit for independent composition coverage.
    // forge-lint: disable-next-item(calls-loop, asm-keccak256)
    function _certificate(Codec.Package memory pack, uint8 version, uint256 count) private view returns (bytes memory) {
        Certificate.Statement memory statement;
        statement.protocolVersion = version;
        statement.sourceDomain = pack.message.sourceDomain;
        statement.sourceGateway = pack.message.sourceGateway;
        statement.epoch = pack.batch.epoch;
        statement.viewNumber = version == Certificate.LEGACY_VERSION ? 0 : VIEW;
        statement.batchId = pack.batch.batchId;
        statement.messageRoot = pack.envelope.messageRoot;
        statement.validatorEpoch = version == Certificate.EPOCH_VERSION ? CURRENT_AUTHORITY : INITIAL_AUTHORITY;
        (address[COMMITTEE_SIZE] memory members, uint8 quorum, bytes32 committee) = validators.getValidatorSet(statement.validatorEpoch);
        assertEq(uint256(quorum), QUORUM);
        statement.committeeDigest = committee;
        statement.proposalDigest = _proposal(statement, members);
        Certificate.Evidence[] memory votes = new Certificate.Evidence[](count);
        for (uint256 index = 0; index < count; index++) {
            votes[index] = _signedVote(statement, members[index]);
        }
        return abi.encode(version, _wireStatement(statement), _voteDigest(statement, address(0), false), votes);
    }

    function _wireStatement(Certificate.Statement memory statement) private pure returns (bytes memory) {
        return bytes.concat(abi.encode(statement.sourceDomain, statement.sourceGateway, statement.epoch),
            statement.protocolVersion == Certificate.LEGACY_VERSION ? bytes("") : abi.encode(statement.viewNumber),
            abi.encode(statement.batchId, statement.messageRoot, statement.proposalDigest, statement.committeeDigest),
            statement.protocolVersion == Certificate.EPOCH_VERSION ? abi.encode(statement.validatorEpoch) : bytes(""));
    }

    // At most five known public local fixture scalars are checked; no runtime validator is synthesized here.
    // forge-lint: disable-next-item(calls-loop, asm-keccak256)
    function _signedVote(Certificate.Statement memory statement, address voter) private pure returns (Certificate.Evidence memory) {
        bytes32 digest = _voteDigest(statement, voter, true);
        uint256 key = 1;
        while (vm.addr(key) != voter) key++;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        return Certificate.Evidence(voter, digest, abi.encodePacked(r, s, v));
    }

    function _prefix(Certificate.Statement memory statement) private pure returns (bytes memory prefix) {
        prefix = abi.encode(statement.protocolVersion, statement.sourceDomain, statement.sourceGateway, statement.epoch);
        if (statement.protocolVersion != Certificate.LEGACY_VERSION) prefix = bytes.concat(prefix, abi.encode(statement.viewNumber));
    }

    // Independent test preimages intentionally retain their complete readable ABI/typed-string encoding.
    // forge-lint: disable-next-item(asm-keccak256)
    function _proposal(Certificate.Statement memory statement, address[COMMITTEE_SIZE] memory members) private pure returns (bytes32) {
        string memory schema = string.concat("PBFTPrePrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch",
            statement.protocolVersion == Certificate.LEGACY_VERSION ? "" : ",uint256 view", ",bytes32 batchId,bytes32 messageRoot,address primaryIdentity",
            statement.protocolVersion == Certificate.EPOCH_VERSION ? ",uint256 validatorEpoch,bytes32 committeeDigest)" : ")");
        bytes memory encoded = bytes.concat(abi.encode(keccak256(bytes(schema))), _prefix(statement),
            abi.encode(statement.batchId, statement.messageRoot,
                members[(statement.epoch % COMMITTEE_SIZE + statement.viewNumber % COMMITTEE_SIZE) % COMMITTEE_SIZE]));
        if (statement.protocolVersion == Certificate.EPOCH_VERSION) encoded = bytes.concat(encoded, abi.encode(statement.validatorEpoch, statement.committeeDigest));
        return keccak256(encoded);
    }

    // Keep original version-specific test preimages visible, without optimizing their reference hashing.
    // forge-lint: disable-next-item(asm-keccak256)
    function _voteDigest(Certificate.Statement memory statement, address voter, bool commit) private pure returns (bytes32) {
        string memory schema = string.concat(commit ? "PBFTCommit" : "PBFTQuorumCertificate",
            "(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch",
            statement.protocolVersion == Certificate.LEGACY_VERSION ? "" : ",uint256 view",
            ",bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest",
            commit ? ",address voterIdentity" : "", statement.protocolVersion == Certificate.EPOCH_VERSION ? ",uint256 validatorEpoch)" : ")");
        bytes memory encoded = bytes.concat(abi.encode(keccak256(bytes(schema))), _prefix(statement),
            abi.encode(statement.batchId, statement.messageRoot, statement.proposalDigest, statement.committeeDigest));
        if (commit) encoded = bytes.concat(encoded, abi.encode(voter));
        if (statement.protocolVersion == Certificate.EPOCH_VERSION) encoded = bytes.concat(encoded, abi.encode(statement.validatorEpoch));
        return keccak256(encoded);
    }

    function _putWord(bytes memory value, uint256 offset, uint256 word) private pure {
        // Test-only exact byte corruption within an already allocated ABI frame.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") { mstore(add(add(value, WORD), offset), word) }
    }
}
