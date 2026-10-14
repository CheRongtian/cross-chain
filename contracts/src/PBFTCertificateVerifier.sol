// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPBFTCertificateVerifier} from "./interfaces/IPBFTCertificateVerifier.sol";
import {IValidatorSetRegistry} from "./interfaces/IValidatorSetRegistry.sol";
import {PBFTCertificateCodec as Codec} from "./libraries/PBFTCertificateCodec.sol";

/// @notice Verifies PBFT QC signatures against immutable, exact historical authority.
contract PBFTCertificateVerifier is IPBFTCertificateVerifier {
    uint256 private constant COMMITTEE_SIZE = 4;
    uint256 private constant QUORUM = 3;
    uint256 private constant WORD = 32;
    uint256 private constant CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    uint8 private constant RECOVERY_BASE = 27;

    bytes32 private constant PROPOSAL_V1 = keccak256("PBFTPrePrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32 batchId,bytes32 messageRoot,address primaryIdentity)");
    bytes32 private constant PROPOSAL_V2 = keccak256("PBFTPrePrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,address primaryIdentity)");
    bytes32 private constant PROPOSAL_V3 = keccak256("PBFTPrePrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,address primaryIdentity,uint256 validatorEpoch,bytes32 committeeDigest)");
    bytes32 private constant COMMIT_V1 = keccak256("PBFTCommit(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest,address voterIdentity)");
    bytes32 private constant COMMIT_V2 = keccak256("PBFTCommit(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest,address voterIdentity)");
    bytes32 private constant COMMIT_V3 = keccak256("PBFTCommit(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest,address voterIdentity,uint256 validatorEpoch)");
    bytes32 private constant QC_V1 = keccak256("PBFTQuorumCertificate(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest)");
    bytes32 private constant QC_V2 = keccak256("PBFTQuorumCertificate(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest)");
    bytes32 private constant QC_V3 = keccak256("PBFTQuorumCertificate(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest,uint256 validatorEpoch)");

    // Matches the existing registry getter naming convention.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IValidatorSetRegistry public immutable validatorSetRegistry;

    error InvalidValidatorSetRegistry();
    error ContextMismatch();
    error LegacyAuthorityMismatch();
    error CommitteeDigestMismatch();
    error ProposalDigestMismatch();
    error QuorumCertificateDigestMismatch();
    error CommitDigestMismatch(uint256 index);
    error InvalidSignature(uint256 index);
    error SignerIdentityMismatch(uint256 index);
    error NonmemberSigner(address signer);
    error NoncanonicalSigners();

    constructor(address validatorSetRegistry_) {
        if (validatorSetRegistry_ == address(0) || validatorSetRegistry_.code.length == 0) {
            revert InvalidValidatorSetRegistry();
        }
        validatorSetRegistry = IValidatorSetRegistry(validatorSetRegistry_);
    }

    /// @inheritdoc IPBFTCertificateVerifier
    function verifyCertificate(bytes calldata encoded, ExpectedContext calldata expected)
        external
        view
        override
        returns (bool)
    {
        Codec.Certificate memory certificate = Codec.decode(encoded);
        Codec.Statement memory statement = certificate.statement;
        if (
            statement.protocolVersion != expected.protocolVersion || statement.sourceDomain != expected.sourceDomain
                || statement.sourceGateway != expected.sourceGateway || statement.epoch != expected.batchEpoch
                || statement.viewNumber != expected.viewNumber || statement.batchId != expected.batchId
                || statement.messageRoot != expected.messageRoot
        ) revert ContextMismatch();
        uint256 authorityEpoch = expected.authorityEpoch;
        if (statement.protocolVersion == Codec.EPOCH_VERSION) {
            if (statement.validatorEpoch != authorityEpoch) revert ContextMismatch();
        } else if (authorityEpoch != validatorSetRegistry.initialValidatorEpoch()) {
            revert LegacyAuthorityMismatch();
        }
        (address[COMMITTEE_SIZE] memory validators, uint8 quorum, bytes32 digest) =
            validatorSetRegistry.getValidatorSet(authorityEpoch);
        if (quorum != QUORUM || statement.committeeDigest != digest) revert CommitteeDigestMismatch();
        if (statement.proposalDigest != _proposalDigest(statement, validators)) revert ProposalDigestMismatch();
        if (certificate.qcDigest != _statementDigest(statement, address(0), false)) {
            revert QuorumCertificateDigestMismatch();
        }
        _verifyEvidence(certificate, validators);
        return true;
    }

    // The parser bounds this loop to four entries. Every digest, identity and membership
    // check must fail immediately, including checks on an optional fourth signature.
    // forge-lint: disable-next-item(calls-loop, require-revert-in-loop)
    function _verifyEvidence(Codec.Certificate memory certificate, address[COMMITTEE_SIZE] memory validators)
        private
        pure
    {
        address previous = address(0);
        for (uint256 index = 0; index < certificate.commits.length; ++index) {
            Codec.Evidence memory evidence = certificate.commits[index];
            bytes32 rawDigest = _statementDigest(certificate.statement, evidence.voterIdentity, true);
            if (evidence.commitDigest != rawDigest) revert CommitDigestMismatch(index);
            address signer = _recover(rawDigest, evidence.signature, index);
            if (signer != evidence.voterIdentity) revert SignerIdentityMismatch(index);
            if (!_isMember(validators, signer)) revert NonmemberSigner(signer);
            // Strict ascending recovered identities simultaneously reject duplicates and reordering.
            if (uint160(signer) <= uint160(previous)) revert NoncanonicalSigners();
            previous = signer;
        }
    }

    function _proposalDigest(Codec.Statement memory statement, address[COMMITTEE_SIZE] memory validators)
        private
        pure
        returns (bytes32)
    {
        // Modular addition preserves the off-chain BigInt primary rule at the uint256 boundary.
        address primary = validators[
            (statement.epoch % COMMITTEE_SIZE + statement.viewNumber % COMMITTEE_SIZE) % COMMITTEE_SIZE
        ];
        bytes32 typehash = statement.protocolVersion == Codec.LEGACY_VERSION
            ? PROPOSAL_V1
            : (statement.protocolVersion == Codec.VIEW_VERSION ? PROPOSAL_V2 : PROPOSAL_V3);
        bytes memory encoded = _prefix(typehash, statement);
        encoded = bytes.concat(encoded, abi.encode(statement.batchId, statement.messageRoot, primary));
        if (statement.protocolVersion == Codec.EPOCH_VERSION) {
            encoded = bytes.concat(encoded, abi.encode(statement.validatorEpoch, statement.committeeDigest));
        }
        return _hash(encoded);
    }

    function _statementDigest(Codec.Statement memory statement, address voter, bool commit)
        private
        pure
        returns (bytes32)
    {
        bytes32 typehash = bytes32(0);
        if (statement.protocolVersion == Codec.LEGACY_VERSION) typehash = commit ? COMMIT_V1 : QC_V1;
        else if (statement.protocolVersion == Codec.VIEW_VERSION) typehash = commit ? COMMIT_V2 : QC_V2;
        else typehash = commit ? COMMIT_V3 : QC_V3;
        bytes memory encoded = bytes.concat(
            _prefix(typehash, statement),
            abi.encode(statement.batchId, statement.messageRoot, statement.proposalDigest, statement.committeeDigest)
        );
        if (commit) encoded = bytes.concat(encoded, abi.encode(voter));
        // v3 extends the legacy signed fields at the end, after voterIdentity for COMMIT.
        if (statement.protocolVersion == Codec.EPOCH_VERSION) encoded = bytes.concat(encoded, abi.encode(statement.validatorEpoch));
        return _hash(encoded);
    }

    function _prefix(bytes32 typehash, Codec.Statement memory statement) private pure returns (bytes memory encoded) {
        encoded = abi.encode(typehash, statement.protocolVersion, statement.sourceDomain, statement.sourceGateway, statement.epoch);
        if (statement.protocolVersion != Codec.LEGACY_VERSION) {
            encoded = bytes.concat(encoded, abi.encode(statement.viewNumber));
        }
    }

    // Invoked once per bounded evidence entry; invalid recovery must stop that iteration immediately.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _recover(bytes32 rawDigest, bytes memory signature, uint256 index) private pure returns (address signer) {
        bytes32 r = bytes32(0);
        bytes32 s = bytes32(0);
        uint8 v = 0;
        // The codec guarantees a 65-byte signature and canonical outer ABI padding.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            r := mload(add(signature, WORD))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }
        if (v < 2) v += RECOVERY_BASE;
        if (v != RECOVERY_BASE && v != RECOVERY_BASE + 1) revert InvalidSignature(index);
        if (uint256(r) == 0 || uint256(r) >= CURVE_ORDER || uint256(s) == 0 || uint256(s) >= CURVE_ORDER) {
            revert InvalidSignature(index);
        }
        // Existing viem/noble recovery accepts high-s. Keep that compatibility; uniqueness uses identities.
        bytes32 signingDigest = _hash(abi.encodePacked("\x19Ethereum Signed Message:\n32", rawDigest));
        // r/s/v are range-checked above; zero recovery, claimed identity, membership and duplicate
        // recovered identities are checked before acceptance. Low-s enforcement would change the protocol.
        // forge-lint: disable-next-line(ecrecover)
        signer = ecrecover(signingDigest, v, r, s);
        if (signer == address(0)) revert InvalidSignature(index);
    }

    function _isMember(address[COMMITTEE_SIZE] memory validators, address signer) private pure returns (bool) {
        return signer == validators[0] || signer == validators[1] || signer == validators[2] || signer == validators[3];
    }

    function _hash(bytes memory encoded) private pure returns (bytes32 digest) {
        // Hash exact protocol bytes; no serialization or type-domain change is introduced.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            digest := keccak256(add(encoded, WORD), mload(encoded))
        }
    }
}
