// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {CredentialVerifier} from "../src/CredentialVerifier.sol";
import {ICredentialVerifier} from "../src/interfaces/ICredentialVerifier.sol";
import {Groth16Verifier} from "../generated/Groth16Verifier.sol";
import {CredentialProofFixture} from "../generated/CredentialProofFixture.sol";
import {ForwardCredentialProofFixture} from "../generated/ForwardCredentialProofFixture.sol";
import {LegacyCredentialProofFixture} from "../generated/LegacyCredentialProofFixture.sol";

contract CredentialVerifierTest is Test {
    uint256 internal constant PUBLIC_SIGNAL_COUNT = 12;
    uint256 internal constant FORWARD_INTENT_HI_INDEX = 9;
    uint256 internal constant FORWARD_INTENT_LO_INDEX = 10;
    uint256 internal constant AUTHORIZATION_VALID_UNTIL_INDEX = 11;

    CredentialVerifier internal verifier;

    function setUp() public {
        Groth16Verifier generatedVerifier = new Groth16Verifier();
        verifier = new CredentialVerifier(address(generatedVerifier));
    }

    function testRejectsAddressWithoutVerifierCode() public {
        vm.expectRevert(CredentialVerifier.InvalidGroth16Verifier.selector);
        new CredentialVerifier(address(0));
    }

    function testLegacyProofRejectedWithWellFormedTwelveSignalStatement() public view {
        _assertRejected(LegacyCredentialProofFixture.proofA(), LegacyCredentialProofFixture.proofB(),
            LegacyCredentialProofFixture.proofC(), LegacyCredentialProofFixture.publicSignals());
    }

    function testAcceptsValidCredentialProof() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();

        bool accepted = verifier.verifyCredentialProof(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            _publicInputs(publicSignals)
        );

        assertTrue(accepted);
    }

    function testForwardingProofBindsBothLimbsAndTheirOrder() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory signals = ForwardCredentialProofFixture.publicSignals();
        assertTrue(verifier.verifyCredentialProof(ForwardCredentialProofFixture.proofA(),
            ForwardCredentialProofFixture.proofB(), ForwardCredentialProofFixture.proofC(), _publicInputs(signals)));
        assertTrue(signals[FORWARD_INTENT_HI_INDEX] != signals[FORWARD_INTENT_LO_INDEX]);
        for (uint256 index = FORWARD_INTENT_HI_INDEX; index <= FORWARD_INTENT_LO_INDEX; index++) {
            uint256 original = signals[index];
            signals[index] = original + 1;
            _assertRejected(ForwardCredentialProofFixture.proofA(), ForwardCredentialProofFixture.proofB(),
                ForwardCredentialProofFixture.proofC(), signals);
            signals[index] = uint256(1) << 128;
            _assertRejected(ForwardCredentialProofFixture.proofA(), ForwardCredentialProofFixture.proofB(),
                ForwardCredentialProofFixture.proofC(), signals);
            signals[index] = original;
        }
        (signals[FORWARD_INTENT_HI_INDEX], signals[FORWARD_INTENT_LO_INDEX]) = (signals[FORWARD_INTENT_LO_INDEX], signals[FORWARD_INTENT_HI_INDEX]);
        _assertRejected(ForwardCredentialProofFixture.proofA(), ForwardCredentialProofFixture.proofB(),
            ForwardCredentialProofFixture.proofC(), signals);
    }

    function testRejectsTamperedProof() public view {
        uint256[2] memory proofA = CredentialProofFixture.proofA();
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        proofA[0] += 1;

        _assertRejected(proofA, CredentialProofFixture.proofB(), CredentialProofFixture.proofC(), publicSignals);
    }

    function testRejectsWrongCredentialCommitment() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[0] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongTrustedIssuer() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[1] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongRequiredRole() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[2] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongCurrentTimestamp() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[3] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongCredentialStateRoot() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[4] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongApplicationDomain() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[5] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongPolicyEpoch() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[6] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongActionContext() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[7] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongNullifier() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[8] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    // All mutations remain in the scalar field and retain the same valid proof.
    // Unexpected verifier reverts propagate; only an explicit false is rejection.
    // forge-lint: disable-next-item(calls-loop)
    function testZkSecurityEveryPublicSignalIsCryptographicallyBound() public view {
        uint256[PUBLIC_SIGNAL_COUNT] memory signals = CredentialProofFixture.publicSignals();
        assertTrue(verifier.verifyCredentialProof(CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(), CredentialProofFixture.proofC(), _publicInputs(signals)));
        uint256 scalarField = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
        for (uint256 index = 0; index < PUBLIC_SIGNAL_COUNT; index++) {
            uint256 original = signals[index];
            signals[index] = (original + 1) % scalarField;
            _assertRejected(CredentialProofFixture.proofA(), CredentialProofFixture.proofB(),
                CredentialProofFixture.proofC(), signals);
            signals[index] = original;
        }
        assertTrue(verifier.verifyCredentialProof(CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(), CredentialProofFixture.proofC(), _publicInputs(signals)));
    }

    function testPublicSignalOrderIsFixed() public view {
        assertEq(verifier.CREDENTIAL_COMMITMENT_INDEX(), 0);
        assertEq(verifier.TRUSTED_ISSUER_INDEX(), 1);
        assertEq(verifier.REQUIRED_ROLE_INDEX(), 2);
        assertEq(verifier.CURRENT_TIMESTAMP_INDEX(), 3);
        assertEq(verifier.CREDENTIAL_STATE_ROOT_INDEX(), 4);
        assertEq(verifier.APPLICATION_DOMAIN_INDEX(), 5);
        assertEq(verifier.POLICY_EPOCH_INDEX(), 6);
        assertEq(verifier.ACTION_CONTEXT_INDEX(), 7);
        assertEq(verifier.NULLIFIER_INDEX(), 8);
        assertEq(verifier.FORWARD_INTENT_DIGEST_HI_INDEX(), 9);
        assertEq(verifier.FORWARD_INTENT_DIGEST_LO_INDEX(), 10);
        assertEq(verifier.AUTHORIZATION_VALID_UNTIL_INDEX(), AUTHORIZATION_VALID_UNTIL_INDEX);
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals = CredentialProofFixture.publicSignals();
        (publicSignals[1], publicSignals[2]) = (publicSignals[2], publicSignals[1]);

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testZkSecurityRejectsReversedG2CoordinateOrder() public view {
        uint256[2][2] memory proofB = CredentialProofFixture.proofB();
        (proofB[0][0], proofB[0][1]) = (proofB[0][1], proofB[0][0]);
        (proofB[1][0], proofB[1][1]) = (proofB[1][1], proofB[1][0]);
        _assertRejected(CredentialProofFixture.proofA(), proofB, CredentialProofFixture.proofC(),
            CredentialProofFixture.publicSignals());
    }

    // Each bounded mutation intentionally exercises the local EVM verifier through this helper.
    // forge-lint: disable-next-item(calls-loop)
    function _assertRejected(
        uint256[2] memory proofA,
        uint256[2][2] memory proofB,
        uint256[2] memory proofC,
        uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals
    ) internal view {
        assertFalse(verifier.verifyCredentialProof(proofA, proofB, proofC, _publicInputs(publicSignals)));
    }

    function _publicInputs(uint256[PUBLIC_SIGNAL_COUNT] memory publicSignals)
        internal
        pure
        returns (ICredentialVerifier.CredentialPublicInputs memory)
    {
        return ICredentialVerifier.CredentialPublicInputs({
            credentialCommitment: publicSignals[0],
            trustedIssuer: publicSignals[1],
            requiredRole: publicSignals[2],
            currentTimestamp: publicSignals[3],
            credentialStateRoot: publicSignals[4],
            applicationDomain: publicSignals[5],
            policyEpoch: publicSignals[6],
            actionContext: publicSignals[7],
            nullifier: publicSignals[8],
            forwardIntentDigestHi: publicSignals[9],
            forwardIntentDigestLo: publicSignals[10],
            authorizationValidUntil: publicSignals[AUTHORIZATION_VALID_UNTIL_INDEX]
        });
    }
}
