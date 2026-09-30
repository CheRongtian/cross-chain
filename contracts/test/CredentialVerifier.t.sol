// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {CredentialVerifier} from "../src/CredentialVerifier.sol";
import {ICredentialVerifier} from "../src/interfaces/ICredentialVerifier.sol";
import {Groth16Verifier} from "../generated/Groth16Verifier.sol";
import {CredentialProofFixture} from "../generated/CredentialProofFixture.sol";

contract CredentialVerifierTest is Test {
    CredentialVerifier internal verifier;

    function setUp() public {
        Groth16Verifier generatedVerifier = new Groth16Verifier();
        verifier = new CredentialVerifier(address(generatedVerifier));
    }

    function testRejectsAddressWithoutVerifierCode() public {
        vm.expectRevert(CredentialVerifier.InvalidGroth16Verifier.selector);
        new CredentialVerifier(address(0));
    }

    function testAcceptsValidCredentialProof() public view {
        uint256[4] memory publicSignals = CredentialProofFixture.publicSignals();

        bool accepted = verifier.verifyCredentialProof(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals[0],
            publicSignals[1],
            publicSignals[2],
            publicSignals[3]
        );

        assertTrue(accepted);
    }

    function testRejectsTamperedProof() public {
        uint256[2] memory proofA = CredentialProofFixture.proofA();
        uint256[4] memory publicSignals = CredentialProofFixture.publicSignals();
        proofA[0] += 1;

        _assertRejected(proofA, CredentialProofFixture.proofB(), CredentialProofFixture.proofC(), publicSignals);
    }

    function testRejectsWrongCredentialCommitment() public {
        uint256[4] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[0] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongTrustedIssuer() public {
        uint256[4] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[1] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongRequiredRole() public {
        uint256[4] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[2] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testRejectsWrongCurrentTimestamp() public {
        uint256[4] memory publicSignals = CredentialProofFixture.publicSignals();
        publicSignals[3] += 1;

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function testPublicSignalOrderIsFixed() public {
        uint256[4] memory publicSignals = CredentialProofFixture.publicSignals();
        (publicSignals[1], publicSignals[2]) = (publicSignals[2], publicSignals[1]);

        _assertRejected(
            CredentialProofFixture.proofA(),
            CredentialProofFixture.proofB(),
            CredentialProofFixture.proofC(),
            publicSignals
        );
    }

    function _assertRejected(
        uint256[2] memory proofA,
        uint256[2][2] memory proofB,
        uint256[2] memory proofC,
        uint256[4] memory publicSignals
    ) internal view {
        bytes memory callData = abi.encodeCall(
            ICredentialVerifier.verifyCredentialProof,
            (proofA, proofB, proofC, publicSignals[0], publicSignals[1], publicSignals[2], publicSignals[3])
        );
        (bool callSucceeded, bytes memory returnData) = address(verifier).staticcall(callData);

        if (callSucceeded) {
            assertFalse(abi.decode(returnData, (bool)));
        }
    }
}
