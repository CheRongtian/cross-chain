pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template CredentialAuthorization() {
    signal input subject;
    signal input issuer;
    signal input role;
    signal input expiry;
    signal input credentialId;

    signal input credentialCommitment;
    signal input trustedIssuer;
    signal input requiredRole;
    signal input currentTimestamp;

    component commitment = Poseidon(6);
    commitment.inputs[0] <== 1;
    commitment.inputs[1] <== subject;
    commitment.inputs[2] <== issuer;
    commitment.inputs[3] <== role;
    commitment.inputs[4] <== expiry;
    commitment.inputs[5] <== credentialId;
    commitment.out === credentialCommitment;

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

component main {public [credentialCommitment, trustedIssuer, requiredRole, currentTimestamp]} = CredentialAuthorization();
