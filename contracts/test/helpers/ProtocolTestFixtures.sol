// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageCodec} from "../../src/MessageCodec.sol";
import {MessageMerkle} from "../../src/MessageMerkle.sol";
import {MerkleInclusionVerifier} from "../../src/MerkleInclusionVerifier.sol";
import {ValidatorSetRegistry} from "../../src/ValidatorSetRegistry.sol";
import {IPBFTCertificateVerifier} from "../../src/interfaces/IPBFTCertificateVerifier.sol";
import {DeliveryPackageCodec as Codec} from "../../src/libraries/DeliveryPackageCodec.sol";
import {PBFTCertificateCodec as Certificate} from "../../src/libraries/PBFTCertificateCodec.sol";

/// @dev TEST-ONLY construction of evidence for the real production verifiers. No verifier is implemented here.
abstract contract ProtocolTestFixtures is Test {
    uint256 internal constant FIXTURE_WORD = 32;
    uint256 internal constant FIXTURE_COMMITTEE_SIZE = 4;
    uint256 internal constant FIXTURE_QUORUM = 3;
    uint256 internal constant FIXTURE_FIRST_AUTHORITY = 7;
    uint256 internal constant FIXTURE_SECOND_AUTHORITY = 8;

    error UnknownFixtureSigner(address signer);

    function _encode(Codec.Package memory pack) internal pure returns (bytes memory) {
        pack.envelope.messageBytes = _messageBytes(pack.message);
        pack.envelope.batchBytes = abi.encode(pack.batch.version, pack.batch.epoch, pack.batch.batchId, pack.batch.messageIds);
        return _envelopeBytes(pack.envelope);
    }

    function _messageBytes(Codec.WireMessage memory message) internal pure returns (bytes memory) {
        return _flat(abi.encode(message));
    }

    function _envelopeBytes(Codec.Envelope memory envelope) internal pure returns (bytes memory) {
        return _flat(abi.encode(envelope));
    }

    // The existing transport is a flat ABI argument list, not an ABI dynamic tuple with an outer offset.
    // forge-lint: disable-next-item(calls-loop)
    function _flat(bytes memory tuple) internal pure returns (bytes memory flat) {
        assertGe(tuple.length, FIXTURE_WORD, "fixture tuple head");
        flat = new bytes(tuple.length - FIXTURE_WORD);
        for (uint256 index = 0; index < flat.length; index++) flat[index] = tuple[index + FIXTURE_WORD];
    }

    /// @dev Builds a path at any position using only production leaf/node primitives, including odd duplication.
    // forge-lint: disable-next-item(calls-loop)
    function _merklePath(bytes32 batchId, bytes32[] memory ids, uint256 position)
        internal pure returns (bytes32 root, bytes32[] memory siblings)
    {
        assertGt(ids.length, 0, "fixture empty tree");
        assertLt(position, ids.length, "fixture position");
        uint256 depth = 0;
        for (uint256 width = ids.length; width > 1; width = (width + 1) / 2) depth++;
        siblings = new bytes32[](depth);
        bytes32[] memory nodes = new bytes32[](ids.length);
        for (uint256 index = 0; index < ids.length; index++) nodes[index] = MessageMerkle.computeLeaf(batchId, index, ids[index]);
        uint256 length = nodes.length;
        for (uint256 level = 0; length > 1; level++) {
            uint256 sibling = position ^ 1;
            siblings[level] = nodes[sibling < length ? sibling : position];
            for (uint256 index = 0; index < length; index += 2) {
                nodes[index / 2] = MessageMerkle.hashNode(nodes[index], nodes[index + 1 < length ? index + 1 : index]);
            }
            position /= 2;
            length = (length + 1) / 2;
        }
        return (nodes[0], siblings);
    }

    // These five public deterministic scalars belong exclusively to the local test EVM.
    // forge-lint: disable-next-item(calls-loop)
    function _committee(uint256 authority) internal pure returns (address[FIXTURE_COMMITTEE_SIZE] memory members) {
        assertTrue(authority == FIXTURE_FIRST_AUTHORITY || authority == FIXTURE_SECOND_AUTHORITY, "fixture authority");
        for (uint256 index = 0; index < FIXTURE_COMMITTEE_SIZE; index++) {
            members[index] = vm.addr(index + (authority == FIXTURE_FIRST_AUTHORITY ? 1 : 2));
        }
        for (uint256 index = 1; index < FIXTURE_COMMITTEE_SIZE; index++) {
            for (uint256 prior = index; prior > 0 && uint160(members[prior - 1]) > uint160(members[prior]); prior--) {
                (members[prior - 1], members[prior]) = (members[prior], members[prior - 1]);
            }
        }
    }

    // Fixture/corpus loops read only the fixed local registry. The exemption must follow the actual callee.
    // forge-lint: disable-next-item(calls-loop)
    function _statement(
        ValidatorSetRegistry registry, Codec.Package memory pack, uint8 version, uint256 authority, uint256 viewNumber
    ) internal view returns (Certificate.Statement memory statement) {
        statement.protocolVersion = version;
        statement.sourceDomain = pack.message.sourceDomain;
        statement.sourceGateway = pack.message.sourceGateway;
        statement.epoch = pack.batch.epoch;
        statement.viewNumber = version == Certificate.LEGACY_VERSION ? 0 : viewNumber;
        statement.batchId = pack.batch.batchId;
        statement.messageRoot = pack.envelope.messageRoot;
        statement.validatorEpoch = authority;
        (address[FIXTURE_COMMITTEE_SIZE] memory members, uint8 quorum, bytes32 committee) = registry.getValidatorSet(authority);
        assertEq(uint256(quorum), FIXTURE_QUORUM);
        statement.committeeDigest = committee;
        statement.proposalDigest = _proposal(statement, members);
    }

    // forge-lint: disable-next-item(calls-loop)
    function _makeCertificate(ValidatorSetRegistry registry, Certificate.Statement memory statement, uint256 count)
        internal view returns (bytes memory)
    {
        assertLe(count, FIXTURE_COMMITTEE_SIZE, "fixture evidence count");
        (address[FIXTURE_COMMITTEE_SIZE] memory members, uint8 quorum, bytes32 committee) =
            registry.getValidatorSet(statement.validatorEpoch);
        assertEq(uint256(quorum), FIXTURE_QUORUM, "fixture signing quorum");
        assertEq(committee, statement.committeeDigest, "fixture signing committee");
        Certificate.Evidence[] memory votes = new Certificate.Evidence[](count);
        for (uint256 index = 0; index < count; index++) votes[index] = _signedVote(statement, members[index]);
        return _encodeCertificate(statement, votes);
    }

    function _encodeCertificate(Certificate.Statement memory statement, Certificate.Evidence[] memory votes)
        internal pure returns (bytes memory)
    {
        return abi.encode(statement.protocolVersion, _wireStatement(statement), _voteDigest(statement, address(0), false), votes);
    }

    function _wireStatement(Certificate.Statement memory statement) internal pure returns (bytes memory) {
        return bytes.concat(abi.encode(statement.sourceDomain, statement.sourceGateway, statement.epoch),
            statement.protocolVersion == Certificate.LEGACY_VERSION ? bytes("") : abi.encode(statement.viewNumber),
            abi.encode(statement.batchId, statement.messageRoot, statement.proposalDigest, statement.committeeDigest),
            statement.protocolVersion == Certificate.EPOCH_VERSION ? abi.encode(statement.validatorEpoch) : bytes(""));
    }

    // Only the bounded local key corpus can sign. An unknown signer must stop the caller's bounded vote loop,
    // including when this helper is reached transitively; that error is never counted as protocol rejection.
    // forge-lint: disable-next-item(calls-loop, asm-keccak256, require-revert-in-loop)
    function _signedVote(Certificate.Statement memory statement, address voter) internal pure returns (Certificate.Evidence memory) {
        bytes32 digest = _voteDigest(statement, voter, true);
        for (uint256 key = 1; key <= 5; key++) {
            if (vm.addr(key) == voter) {
                (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
                return Certificate.Evidence(voter, digest, abi.encodePacked(r, s, v));
            }
        }
        revert UnknownFixtureSigner(voter);
    }

    function _prefix(Certificate.Statement memory statement) internal pure returns (bytes memory prefix) {
        prefix = abi.encode(statement.protocolVersion, statement.sourceDomain, statement.sourceGateway, statement.epoch);
        if (statement.protocolVersion != Certificate.LEGACY_VERSION) prefix = bytes.concat(prefix, abi.encode(statement.viewNumber));
    }

    // Independent signed preimages preserve the three existing frozen schemas.
    // forge-lint: disable-next-item(asm-keccak256)
    function _proposal(Certificate.Statement memory statement, address[FIXTURE_COMMITTEE_SIZE] memory members)
        internal pure returns (bytes32)
    {
        string memory schema = string.concat("PBFTPrePrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch",
            statement.protocolVersion == Certificate.LEGACY_VERSION ? "" : ",uint256 view", ",bytes32 batchId,bytes32 messageRoot,address primaryIdentity",
            statement.protocolVersion == Certificate.EPOCH_VERSION ? ",uint256 validatorEpoch,bytes32 committeeDigest)" : ")");
        bytes memory encoded = bytes.concat(abi.encode(keccak256(bytes(schema))), _prefix(statement),
            abi.encode(statement.batchId, statement.messageRoot,
                members[(statement.epoch % FIXTURE_COMMITTEE_SIZE + statement.viewNumber % FIXTURE_COMMITTEE_SIZE) % FIXTURE_COMMITTEE_SIZE]));
        if (statement.protocolVersion == Certificate.EPOCH_VERSION) encoded = bytes.concat(encoded, abi.encode(statement.validatorEpoch, statement.committeeDigest));
        return keccak256(encoded);
    }

    // forge-lint: disable-next-item(asm-keccak256)
    function _voteDigest(Certificate.Statement memory statement, address voter, bool commit) internal pure returns (bytes32) {
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

    function _expected(Certificate.Statement memory statement)
        internal pure returns (IPBFTCertificateVerifier.ExpectedContext memory expected)
    {
        expected.protocolVersion = statement.protocolVersion;
        expected.sourceDomain = statement.sourceDomain;
        expected.sourceGateway = statement.sourceGateway;
        expected.batchEpoch = statement.epoch;
        expected.viewNumber = statement.viewNumber;
        expected.batchId = statement.batchId;
        expected.messageRoot = statement.messageRoot;
        expected.authorityEpoch = statement.validatorEpoch;
    }

    // Sign a self-consistent altered object only inside the local test EVM, preserving real QC/Merkle checks.
    // Pool setup invokes this helper in a bounded loop; calls target the fixed local production verifiers.
    // forge-lint: disable-next-item(asm-keccak256, calls-loop)
    function _authenticatePackage(
        Codec.Package memory pack, ValidatorSetRegistry registry, MerkleInclusionVerifier merkle, uint256 authority
    ) internal view {
        pack.message.payloadHash = keccak256(pack.message.payload);
        pack.message.messageId = MessageCodec.computeMessageId(Codec.canonicalMessage(pack.message));
        assertEq(pack.batch.messageIds.length, 2, "fixture authentication membership");
        pack.batch.messageIds[0] = pack.message.messageId;
        pack.batch.messageIds[1] = pack.message.messageId ^ bytes32(uint256(1));
        pack.batch.batchId = merkle.computeBatchId(pack.batch.version, pack.message.sourceDomain,
            pack.message.sourceGateway, pack.batch.epoch, pack.batch.messageIds);
        (pack.envelope.messageRoot, pack.envelope.siblings) = _merklePath(pack.batch.batchId, pack.batch.messageIds, 0);
        pack.envelope.certificate = _makeCertificate(registry,
            _statement(registry, pack, Certificate.EPOCH_VERSION, authority, 2), FIXTURE_QUORUM);
    }

    function _putWord(bytes memory value, uint256 offset, uint256 word) internal pure {
        assertLe(offset, value.length, "fixture write offset");
        assertGe(value.length - offset, FIXTURE_WORD, "fixture write width");
        // Exact corruption of an already allocated, bounds-checked ABI word.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") { mstore(add(add(value, 0x20), offset), word) }
    }

    function _getWord(bytes memory value, uint256 offset) internal pure returns (uint256 word) {
        assertLe(offset, value.length, "fixture read offset");
        assertGe(value.length - offset, FIXTURE_WORD, "fixture read width");
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") { word := mload(add(add(value, 0x20), offset)) }
    }

    function _revertSelector(bytes memory reason) internal pure returns (bytes4 selector) {
        assertGe(reason.length, 4, "missing complete revert selector");
        // The length guard ensures all four selector bytes exist. The memory word is within the allocated
        // bytes buffer (including ABI padding); bytes4 intentionally exposes only its leading four bytes.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") { selector := mload(add(reason, 0x20)) }
    }
}
