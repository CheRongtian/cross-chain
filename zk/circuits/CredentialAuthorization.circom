pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template CredentialAuthorization() {
    var CREDENTIAL_STATE_TREE_DEPTH = 8;
    var CREDENTIAL_STATE_LEAF_VERSION = 1;

    signal input subject;
    signal input issuer;
    signal input role;
    signal input expiry;
    signal input credentialId;

    signal input credentialCommitment;
    signal input trustedIssuer;
    signal input requiredRole;
    signal input currentTimestamp;
    signal input credentialStateRoot;

    signal input statePathElements[CREDENTIAL_STATE_TREE_DEPTH];
    signal input statePathIndices[CREDENTIAL_STATE_TREE_DEPTH];

    component commitment = Poseidon(6);
    commitment.inputs[0] <== 1;
    commitment.inputs[1] <== subject;
    commitment.inputs[2] <== issuer;
    commitment.inputs[3] <== role;
    commitment.inputs[4] <== expiry;
    commitment.inputs[5] <== credentialId;
    commitment.out === credentialCommitment;

    component activeLeaf = Poseidon(2);
    activeLeaf.inputs[0] <== CREDENTIAL_STATE_LEAF_VERSION;
    activeLeaf.inputs[1] <== credentialCommitment;

    signal stateHashes[CREDENTIAL_STATE_TREE_DEPTH + 1];
    signal leftNodes[CREDENTIAL_STATE_TREE_DEPTH];
    signal rightNodes[CREDENTIAL_STATE_TREE_DEPTH];
    component stateNodes[CREDENTIAL_STATE_TREE_DEPTH];

    stateHashes[0] <== activeLeaf.out;

    for (var level = 0; level < CREDENTIAL_STATE_TREE_DEPTH; level++) {
        statePathIndices[level] * (statePathIndices[level] - 1) === 0;

        leftNodes[level] <== stateHashes[level]
            + statePathIndices[level] * (statePathElements[level] - stateHashes[level]);
        rightNodes[level] <== statePathElements[level]
            + statePathIndices[level] * (stateHashes[level] - statePathElements[level]);

        stateNodes[level] = Poseidon(2);
        stateNodes[level].inputs[0] <== leftNodes[level];
        stateNodes[level].inputs[1] <== rightNodes[level];
        stateHashes[level + 1] <== stateNodes[level].out;
    }

    stateHashes[CREDENTIAL_STATE_TREE_DEPTH] === credentialStateRoot;

    issuer === trustedIssuer;
    role === requiredRole;

    component expiryRange = Num2Bits(64);
    expiryRange.in <== expiry;

    component currentTimestampRange = Num2Bits(64);
    currentTimestampRange.in <== currentTimestamp;

    component unexpired = LessThan(64);
    unexpired.in[0] <== currentTimestamp;
    unexpired.in[1] <== expiry;
    unexpired.out === 1;
}

component main {public [credentialCommitment, trustedIssuer, requiredRole, currentTimestamp, credentialStateRoot]} = CredentialAuthorization();
