// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProtocolTestFixtures} from "./helpers/ProtocolTestFixtures.sol";
import {ValidatorSetRegistry} from "../src/ValidatorSetRegistry.sol";
import {PBFTCertificateVerifier} from "../src/PBFTCertificateVerifier.sol";
import {IPBFTCertificateVerifier} from "../src/interfaces/IPBFTCertificateVerifier.sol";
import {PBFTCertificateCodec as Certificate} from "../src/libraries/PBFTCertificateCodec.sol";
import {DeliveryPackageCodec as Codec} from "../src/libraries/DeliveryPackageCodec.sol";

contract PBFTCertificateVerifierFuzzTest is ProtocolTestFixtures {
    uint256 private constant CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    ValidatorSetRegistry private registry;
    PBFTCertificateVerifier private verifier;

    function setUp() public {
        registry = new ValidatorSetRegistry(address(this));
        registry.registerValidatorSet(FIXTURE_FIRST_AUTHORITY, _committee(FIXTURE_FIRST_AUTHORITY));
        registry.registerValidatorSet(FIXTURE_SECOND_AUTHORITY, _committee(FIXTURE_SECOND_AUTHORITY));
        verifier = new PBFTCertificateVerifier(address(registry));
    }

    function testFuzzThreeOrFourCanonicalSignersVerify(bytes32 root, uint256 epoch, uint256 viewNumber, bool rotated, bool fourth)
        public view
    {
        Certificate.Statement memory statement = _generated(root, epoch, viewNumber, rotated);
        assertTrue(verifier.verifyCertificate(_makeCertificate(registry, statement, fourth ? 4 : 3), _expected(statement)));
    }

    // Attacker order is submitted unchanged. A quorum also requires strict ascending recovered identities.
    // forge-lint: disable-next-item(calls-loop)
    function testFuzzSignerIndexVectorCannotCountDuplicates(bytes32 root, uint256 indices, bool rotated) public view {
        Certificate.Statement memory statement = _generated(root, indices, indices ^ 1, rotated);
        assertTrue(verifier.verifyCertificate(_makeCertificate(registry, statement, FIXTURE_QUORUM), _expected(statement)));
        address[FIXTURE_COMMITTEE_SIZE] memory members = _committee(statement.validatorEpoch);
        Certificate.Evidence[] memory votes = new Certificate.Evidence[](FIXTURE_QUORUM);
        uint256 previous = 0;
        bool canonical = true;
        for (uint256 index = 0; index < votes.length; index++) {
            uint256 selected = (indices >> (index * 2)) & 3;
            votes[index] = _signedVote(statement, members[selected]);
            if (index > 0 && selected <= previous) canonical = false;
            previous = selected;
        }
        bytes memory encoded = _encodeCertificate(statement, votes);
        if (canonical) assertTrue(verifier.verifyCertificate(encoded, _expected(statement)));
        else assertEq(_reject(encoded, _expected(statement)), abi.encodeWithSelector(PBFTCertificateVerifier.NoncanonicalSigners.selector));
    }

    function testFuzzOneOrTwoIdentitiesNeverFormQuorum(bytes32 root, uint256 signerSeed, bool two, bool fourth)
        public view
    {
        Certificate.Statement memory statement = _generated(root, signerSeed, signerSeed, false);
        assertTrue(verifier.verifyCertificate(_makeCertificate(registry, statement, FIXTURE_QUORUM), _expected(statement)));
        address[FIXTURE_COMMITTEE_SIZE] memory members = _committee(FIXTURE_FIRST_AUTHORITY);
        uint256 first = bound(signerSeed, 0, 2);
        Certificate.Evidence[] memory votes = new Certificate.Evidence[](fourth ? 4 : 3);
        votes[0] = _signedVote(statement, members[first]);
        votes[1] = _signedVote(statement, members[two ? first + 1 : first]);
        votes[2] = votes[1];
        if (fourth) votes[3] = votes[1];
        assertEq(_reject(_encodeCertificate(statement, votes), _expected(statement)),
            abi.encodeWithSelector(PBFTCertificateVerifier.NoncanonicalSigners.selector));
    }

    function testFuzzSignedRootViewAndConsensusEpochAreExact(bytes32 root, uint256 epoch, uint256 viewNumber, uint256 fieldSeed)
        public view
    {
        Certificate.Statement memory statement = _generated(root, epoch, viewNumber, true);
        bytes memory encoded = _makeCertificate(registry, statement, FIXTURE_QUORUM);
        IPBFTCertificateVerifier.ExpectedContext memory expected = _expected(statement);
        assertTrue(verifier.verifyCertificate(encoded, expected));
        uint256 field = bound(fieldSeed, 0, 2);
        if (field == 0) expected.messageRoot ^= bytes32(uint256(1));
        else if (field == 1) expected.viewNumber ^= 1;
        else expected.batchEpoch ^= 1;
        assertEq(_reject(encoded, expected), abi.encodeWithSelector(PBFTCertificateVerifier.ContextMismatch.selector));
    }

    function testFuzzDifferentSignatureBytesFromSameRecoveredSignerDoNotAddWeight(bytes32 root, uint256 epoch) public view {
        Certificate.Statement memory statement = _generated(root, epoch, epoch ^ 1, false);
        assertTrue(verifier.verifyCertificate(_makeCertificate(registry, statement, FIXTURE_QUORUM), _expected(statement)));
        address[FIXTURE_COMMITTEE_SIZE] memory members = _committee(FIXTURE_FIRST_AUTHORITY);
        Certificate.Evidence[] memory votes = new Certificate.Evidence[](FIXTURE_QUORUM);
        votes[0] = _signedVote(statement, members[0]);
        votes[1] = _signedVote(statement, members[0]);
        bytes memory signature = votes[1].signature;
        bytes32 r = bytes32(_getWord(signature, 0));
        uint256 s = _getWord(signature, FIXTURE_WORD);
        uint8 v = uint8(signature[64]);
        // Existing verifier deliberately supports both s forms. These bytes recover the same actual identity.
        votes[1].signature = abi.encodePacked(r, bytes32(CURVE_ORDER - s), v == 27 ? uint8(28) : uint8(27));
        votes[2] = _signedVote(statement, members[1]);
        assertNotEq(votes[0].signature, votes[1].signature);
        assertEq(_reject(_encodeCertificate(statement, votes), _expected(statement)),
            abi.encodeWithSelector(PBFTCertificateVerifier.NoncanonicalSigners.selector));
    }

    function testFuzzThreeUniquePlusDuplicateFourthEntryStillRejects(bytes32 root, uint256 epoch, bool rotated) public view {
        Certificate.Statement memory statement = _generated(root, epoch, epoch ^ 1, rotated);
        bytes memory valid = _makeCertificate(registry, statement, FIXTURE_QUORUM);
        assertTrue(verifier.verifyCertificate(valid, _expected(statement)));
        (,,, Certificate.Evidence[] memory originals) = abi.decode(valid, (uint8, bytes, bytes32, Certificate.Evidence[]));
        Certificate.Evidence[] memory votes = new Certificate.Evidence[](FIXTURE_COMMITTEE_SIZE);
        votes[0] = originals[0];
        votes[1] = originals[1];
        votes[2] = originals[1];
        votes[3] = originals[2];
        assertEq(_reject(_encodeCertificate(statement, votes), _expected(statement)),
            abi.encodeWithSelector(PBFTCertificateVerifier.NoncanonicalSigners.selector));
    }

    function testFuzzHistoricalEpochRelabelCannotReuseSignatures(bytes32 root, uint256 epoch, uint256 viewNumber, bool rotated)
        public view
    {
        Certificate.Statement memory statement = _generated(root, epoch, viewNumber, rotated);
        bytes memory encoded = _makeCertificate(registry, statement, FIXTURE_QUORUM);
        assertTrue(verifier.verifyCertificate(encoded, _expected(statement)));
        statement.validatorEpoch = rotated ? FIXTURE_FIRST_AUTHORITY : FIXTURE_SECOND_AUTHORITY;
        // Change the declared and expected authority together; original committee/signatures cannot move with it.
        _putWord(encoded, FIXTURE_WORD * 13, statement.validatorEpoch);
        assertEq(_reject(encoded, _expected(statement)), abi.encodeWithSelector(PBFTCertificateVerifier.CommitteeDigestMismatch.selector));
    }

    function testFuzzSignatureScalarMutationReachesProductionRecovery(bytes32 root, uint256 seed, uint8 mask) public view {
        Certificate.Statement memory statement = _generated(root, seed, seed ^ 1, true);
        bytes memory valid = _makeCertificate(registry, statement, FIXTURE_QUORUM);
        assertTrue(verifier.verifyCertificate(valid, _expected(statement)));
        (,,, Certificate.Evidence[] memory votes) = abi.decode(valid, (uint8, bytes, bytes32, Certificate.Evidence[]));
        // Mutate r/s, retaining framing and v. The documented 0/1 versus 27/28 v forms are valid equivalents.
        votes[0].signature[bound(seed, 0, 63)] ^= bytes1(mask == 0 ? uint8(1) : mask);
        bytes memory reason = _reject(_encodeCertificate(statement, votes), _expected(statement));
        bytes4 selector = _revertSelector(reason);
        assertTrue(selector == PBFTCertificateVerifier.InvalidSignature.selector
            || selector == PBFTCertificateVerifier.SignerIdentityMismatch.selector,
            "signature mutation rejected at unrelated boundary");
    }

    function testFuzzRecoveryIdEquivalentFormsRemainCompatible(bytes32 root, uint256 seed) public view {
        Certificate.Statement memory statement = _generated(root, seed, seed ^ 1, true);
        bytes memory valid = _makeCertificate(registry, statement, FIXTURE_QUORUM);
        assertTrue(verifier.verifyCertificate(valid, _expected(statement)));
        (,,, Certificate.Evidence[] memory votes) = abi.decode(valid, (uint8, bytes, bytes32, Certificate.Evidence[]));
        uint256 index = bound(seed, 0, votes.length - 1);
        uint8 v = uint8(votes[index].signature[64]);
        assertTrue(v == 27 || v == 28, "fixture recovery id");
        votes[index].signature[64] = bytes1(v - 27);
        assertTrue(verifier.verifyCertificate(_encodeCertificate(statement, votes), _expected(statement)));
    }

    function testFuzzRecomputedContextCannotReuseAnotherRootViewOrEpochSignatures(
        bytes32 root, uint256 epoch, uint256 viewNumber, uint256 fieldSeed
    ) public view {
        Certificate.Statement memory statement = _generated(root, epoch, viewNumber, true);
        bytes memory valid = _makeCertificate(registry, statement, FIXTURE_QUORUM);
        assertTrue(verifier.verifyCertificate(valid, _expected(statement)));
        (,,, Certificate.Evidence[] memory originalVotes) = abi.decode(valid, (uint8, bytes, bytes32, Certificate.Evidence[]));
        uint256 field = bound(fieldSeed, 0, 2);
        if (field == 0) statement.messageRoot ^= bytes32(uint256(1));
        else if (field == 1) statement.viewNumber ^= 1;
        else statement.epoch ^= 1;
        // Rebuild unsigned statement/proposal/QC metadata normally, but preserve the original genuine votes.
        statement.proposalDigest = _proposal(statement, _committee(statement.validatorEpoch));
        assertEq(_reject(_encodeCertificate(statement, originalVotes), _expected(statement)),
            abi.encodeWithSelector(PBFTCertificateVerifier.CommitDigestMismatch.selector, uint256(0)));
    }

    function testFuzzRemovedFutureAndMixedMembersDoNotCount(bytes32 root, uint256 epoch, bool rotated) public view {
        Certificate.Statement memory statement = _generated(root, epoch, epoch ^ 1, rotated);
        assertTrue(verifier.verifyCertificate(_makeCertificate(registry, statement, FIXTURE_QUORUM), _expected(statement)));
        // These are genuine context-correct signatures by V1,V2,V5, not random invalid signature bytes.
        Certificate.Evidence[] memory votes = new Certificate.Evidence[](FIXTURE_QUORUM);
        votes[0] = _signedVote(statement, vm.addr(1));
        votes[1] = _signedVote(statement, vm.addr(2));
        votes[2] = _signedVote(statement, vm.addr(5));
        _sortThree(votes);
        address outsider = vm.addr(rotated ? 1 : 5);
        assertEq(_reject(_encodeCertificate(statement, votes), _expected(statement)),
            abi.encodeWithSelector(PBFTCertificateVerifier.NonmemberSigner.selector, outsider));
    }

    function testFuzzUnknownFullWidthAuthorityFailsClosed(bytes32 root, uint256 unknown) public view {
        Certificate.Statement memory statement = _generated(root, unknown, unknown, true);
        bytes memory encoded = _makeCertificate(registry, statement, FIXTURE_QUORUM);
        assertTrue(verifier.verifyCertificate(encoded, _expected(statement)));
        if (unknown == FIXTURE_FIRST_AUTHORITY || unknown == FIXTURE_SECOND_AUTHORITY) unknown ^= uint256(1) << 255;
        statement.validatorEpoch = unknown;
        _putWord(encoded, FIXTURE_WORD * 13, unknown);
        assertEq(_reject(encoded, _expected(statement)), abi.encodeWithSelector(ValidatorSetRegistry.UnknownValidatorEpoch.selector, unknown));
    }

    function _generated(bytes32 root, uint256 epoch, uint256 viewNumber, bool rotated)
        private view returns (Certificate.Statement memory)
    {
        Codec.Package memory pack;
        pack.message.sourceDomain = 10011;
        pack.message.sourceGateway = address(0x1001);
        pack.batch.epoch = epoch;
        pack.batch.batchId = root ^ bytes32(uint256(1));
        pack.envelope.messageRoot = root;
        return _statement(registry, pack, Certificate.EPOCH_VERSION,
            rotated ? FIXTURE_SECOND_AUTHORITY : FIXTURE_FIRST_AUTHORITY, viewNumber);
    }

    function _reject(bytes memory encoded, IPBFTCertificateVerifier.ExpectedContext memory expected)
        private view returns (bytes memory)
    {
        // STATICCALL additionally enforces read-only verification; registry history must be unchanged.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory reason) = address(verifier).staticcall(abi.encodeCall(verifier.verifyCertificate, (encoded, expected)));
        assertFalse(success, "adversarial certificate accepted");
        assertEq(registry.initialValidatorEpoch(), FIXTURE_FIRST_AUTHORITY);
        assertEq(registry.latestValidatorEpoch(), FIXTURE_SECOND_AUTHORITY);
        return reason;
    }

    // Sort only to isolate nonmembership from ordering. Duplicate/reordered attacker vectors above are never repaired.
    function _sortThree(Certificate.Evidence[] memory votes) private pure {
        for (uint256 index = 1; index < votes.length; index++) {
            for (uint256 prior = index; prior > 0 && uint160(votes[prior - 1].voterIdentity) > uint160(votes[prior].voterIdentity); prior--) {
                (votes[prior - 1], votes[prior]) = (votes[prior], votes[prior - 1]);
            }
        }
    }
}
