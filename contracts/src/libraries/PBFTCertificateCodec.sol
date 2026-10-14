// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Bounded parser for QC_PARAMETERS in indexer/src/relayer/encoding.mjs.
library PBFTCertificateCodec {
    uint8 internal constant LEGACY_VERSION = 1;
    uint8 internal constant VIEW_VERSION = 2;
    uint8 internal constant EPOCH_VERSION = 3;
    uint256 private constant WORD = 32;
    uint256 private constant HEAD_SIZE = 128;
    uint256 private constant LEGACY_STATEMENT_SIZE = 224;
    uint256 private constant TUPLE_SIZE = 224;
    uint256 private constant SIGNATURE_OFFSET = 96;
    uint256 private constant SIGNATURE_LENGTH = 65;
    uint256 private constant QUORUM = 3;
    uint256 private constant COMMITTEE_SIZE = 4;
    uint256 private constant MAX_CERTIFICATE_SIZE = 1504;

    struct Statement {
        uint8 protocolVersion;
        uint256 sourceDomain;
        address sourceGateway;
        uint256 epoch;
        uint256 viewNumber;
        bytes32 batchId;
        bytes32 messageRoot;
        bytes32 proposalDigest;
        bytes32 committeeDigest;
        uint256 validatorEpoch;
    }

    struct Evidence {
        address voterIdentity;
        bytes32 commitDigest;
        bytes signature;
    }

    struct Certificate {
        Statement statement;
        bytes32 qcDigest;
        Evidence[] commits;
    }

    error InvalidCertificateEncoding();
    error UnsupportedProtocolVersion(uint256 version);
    error InvalidEvidenceCount(uint256 count);
    error InvalidSignatureLength(uint256 length);

    /// @dev Exact ABI offsets, widths, lengths and padding are checked before copying evidence.
    // Keep the bounded parser as the library entry point, separate from signature and authority policy.
    // The loop has at most four entries; each noncanonical offset must fail before its evidence is copied.
    // forge-lint: disable-next-item(internal-function-used-once, require-revert-in-loop)
    function decode(bytes calldata encoded) internal pure returns (Certificate memory certificate) {
        if (encoded.length < HEAD_SIZE || encoded.length > MAX_CERTIFICATE_SIZE) {
            revert InvalidCertificateEncoding();
        }
        uint256 version = _word(encoded, 0);
        if (version < LEGACY_VERSION || version > EPOCH_VERSION) revert UnsupportedProtocolVersion(version);
        uint256 statementSize = LEGACY_STATEMENT_SIZE + (version - LEGACY_VERSION) * WORD;
        uint256 evidenceOffset = HEAD_SIZE + WORD + statementSize;
        if (
            _word(encoded, WORD) != HEAD_SIZE || _word(encoded, HEAD_SIZE) != statementSize
                || _word(encoded, SIGNATURE_OFFSET) != evidenceOffset
        ) revert InvalidCertificateEncoding();
        certificate.qcDigest = bytes32(_word(encoded, WORD * 2));
        // The preceding bounded version check also rejects dirty uint8 upper bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        certificate.statement = _statement(encoded, uint8(version));

        uint256 count = _word(encoded, evidenceOffset);
        if (count < QUORUM || count > COMMITTEE_SIZE) revert InvalidEvidenceCount(count);
        uint256 arrayStart = evidenceOffset + WORD;
        if (encoded.length != arrayStart + count * (WORD + TUPLE_SIZE)) revert InvalidCertificateEncoding();
        certificate.commits = new Evidence[](count);
        for (uint256 index = 0; index < count; ++index) {
            uint256 relativeOffset = count * WORD + index * TUPLE_SIZE;
            if (_word(encoded, arrayStart + index * WORD) != relativeOffset) revert InvalidCertificateEncoding();
            certificate.commits[index] = _evidence(encoded, arrayStart + relativeOffset);
        }
    }

    // Each of at most four evidence tuples requires its own immediate length/offset/padding rejection.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _evidence(bytes calldata encoded, uint256 start) private pure returns (Evidence memory) {
        if (_word(encoded, start + WORD * 2) != SIGNATURE_OFFSET) revert InvalidCertificateEncoding();
        uint256 length = _word(encoded, start + SIGNATURE_OFFSET);
        if (length != SIGNATURE_LENGTH) revert InvalidSignatureLength(length);
        uint256 signatureStart = start + SIGNATURE_OFFSET + WORD;
        // The final signature word contains v followed by exactly 31 zero padding bytes.
        if ((_word(encoded, signatureStart + WORD * 2) & (type(uint256).max >> 8)) != 0) {
            revert InvalidCertificateEncoding();
        }
        return Evidence({
            voterIdentity: _address(encoded, start),
            commitDigest: bytes32(_word(encoded, start + WORD)),
            signature: encoded[signatureStart:signatureStart + SIGNATURE_LENGTH]
        });
    }

    function _statement(bytes calldata encoded, uint8 version) private pure returns (Statement memory statement) {
        statement.protocolVersion = version;
        uint256 cursor = HEAD_SIZE + WORD;
        statement.sourceDomain = _word(encoded, cursor);
        cursor += WORD;
        statement.sourceGateway = _address(encoded, cursor);
        cursor += WORD;
        statement.epoch = _word(encoded, cursor);
        cursor += WORD;
        if (version != LEGACY_VERSION) {
            statement.viewNumber = _word(encoded, cursor);
            cursor += WORD;
        }
        statement.batchId = bytes32(_word(encoded, cursor));
        statement.messageRoot = bytes32(_word(encoded, cursor + WORD));
        statement.proposalDigest = bytes32(_word(encoded, cursor + WORD * 2));
        statement.committeeDigest = bytes32(_word(encoded, cursor + WORD * 3));
        if (version == EPOCH_VERSION) statement.validatorEpoch = _word(encoded, cursor + WORD * 4);
    }

    // Used for each bounded tuple as well as the statement; dirty address widths must never be accepted.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _address(bytes calldata encoded, uint256 offset) private pure returns (address) {
        uint256 value = _word(encoded, offset);
        if (value > type(uint160).max) revert InvalidCertificateEncoding();
        // The explicit width check above preserves canonical ABI address encoding.
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(value));
    }

    // Every read, including reads reached from the four-entry loop, must preserve its bounds guard.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _word(bytes calldata encoded, uint256 offset) private pure returns (uint256 value) {
        if (offset > encoded.length || encoded.length - offset < WORD) revert InvalidCertificateEncoding();
        // Read one bounds-checked calldata ABI word without allocating attacker-selected lengths.
        // forge-lint: disable-next-line(inline-assembly)
        assembly ("memory-safe") {
            value := calldataload(add(encoded.offset, offset))
        }
    }
}
