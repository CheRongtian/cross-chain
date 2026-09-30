#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZK_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$ZK_ROOT/.." && pwd)"
BUILD_DIR="$ZK_ROOT/build"
CIRCUIT_BUILD_DIR="$BUILD_DIR/circuit"
INPUT_DIR="$BUILD_DIR/inputs"
PROVING_DIR="$BUILD_DIR/proving"
GENERATED_CONTRACTS_DIR="$PROJECT_ROOT/contracts/generated"
CIRCUIT_FILE="$ZK_ROOT/circuits/CredentialAuthorization.circom"
CIRCUIT_NAME="CredentialAuthorization"
R1CS_FILE="$CIRCUIT_BUILD_DIR/$CIRCUIT_NAME.r1cs"
WASM_FILE="$CIRCUIT_BUILD_DIR/${CIRCUIT_NAME}_js/$CIRCUIT_NAME.wasm"
WITNESS_GENERATOR="$CIRCUIT_BUILD_DIR/${CIRCUIT_NAME}_js/generate_witness.js"
SNARKJS="$ZK_ROOT/node_modules/.bin/snarkjs"
SCALAR_FIELD_PRIME="21888242871839275222246405745257275088548364400416034343698204186575808495617"

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

expect_witness_rejection() {
    local case_name="$1"
    local input_file="$INPUT_DIR/$case_name.json"
    local witness_file="$PROVING_DIR/$case_name.wtns"

    printf '\n[expected witness rejection: %s]\n' "$case_name"

    if node "$WITNESS_GENERATOR" "$WASM_FILE" "$input_file" "$witness_file"; then
        if "$SNARKJS" wtns check "$R1CS_FILE" "$witness_file"; then
            fail "$case_name unexpectedly satisfied the circuit"
        fi
    fi

    printf 'Verified expected circuit rejection: %s\n' "$case_name"
}

verify_policy_proof() {
    local case_name="$1"
    local input_file="$INPUT_DIR/$case_name.json"
    local witness_file="$PROVING_DIR/$case_name.wtns"
    local proof_file="$PROVING_DIR/$case_name-proof.json"
    local public_file="$PROVING_DIR/$case_name-public.json"

    printf '\n[valid credential proof: %s]\n' "$case_name"
    node "$WITNESS_GENERATOR" "$WASM_FILE" "$input_file" "$witness_file"
    "$SNARKJS" wtns check "$R1CS_FILE" "$witness_file"
    "$SNARKJS" groth16 prove "$ZKEY_FINAL" "$witness_file" "$proof_file" "$public_file"
    "$SNARKJS" groth16 verify "$VERIFICATION_KEY" "$public_file" "$proof_file"
    printf 'Verified credential proof: %s\n' "$case_name"
}

printf '\n========================================\n'
printf 'ZK Credential State and Nullifier Verification\n'
printf '========================================\n'

require_command circom
require_command node
[[ -x "$SNARKJS" ]] || fail "snarkjs is unavailable at $SNARKJS; install the pinned zk/package.json dependencies"
[[ -f "$ZK_ROOT/node_modules/circomlib/circuits/poseidon.circom" ]] || fail "circomlib circuit sources are unavailable"
[[ -d "$ZK_ROOT/node_modules/circomlibjs" ]] || fail "circomlibjs is unavailable"

rm -rf -- "$BUILD_DIR"
rm -rf -- "$GENERATED_CONTRACTS_DIR"
mkdir -p "$CIRCUIT_BUILD_DIR" "$INPUT_DIR" "$PROVING_DIR"
mkdir -p "$GENERATED_CONTRACTS_DIR"

printf '\n[compile authorization circuit]\n'
circom "$CIRCUIT_FILE" \
    --r1cs \
    --wasm \
    --sym \
    -l "$ZK_ROOT/node_modules" \
    -o "$CIRCUIT_BUILD_DIR"

printf '\n[prepare deterministic proof inputs]\n'
node "$SCRIPT_DIR/build-credential-state.mjs"
node "$SCRIPT_DIR/build-nullifier-vectors.mjs"
node "$SCRIPT_DIR/build-inputs.mjs"

POT_INITIAL="$PROVING_DIR/pot14_0000.ptau"
POT_CONTRIBUTED="$PROVING_DIR/pot14_0001.ptau"
POT_FINAL="$PROVING_DIR/pot14_final.ptau"
ZKEY_INITIAL="$PROVING_DIR/${CIRCUIT_NAME}_0000.zkey"
ZKEY_FINAL="$PROVING_DIR/${CIRCUIT_NAME}_final.zkey"
VERIFICATION_KEY="$PROVING_DIR/verification_key.json"

printf '\n[create local development proving material]\n'
printf 'This local ceremony is for development verification only and is not production trusted setup.\n'
"$SNARKJS" powersoftau new bn128 14 "$POT_INITIAL" -v
"$SNARKJS" powersoftau contribute \
    "$POT_INITIAL" \
    "$POT_CONTRIBUTED" \
    --name="local-development-contribution" \
    -v \
    -e="cross-chain-local-development-powers-of-tau"
"$SNARKJS" powersoftau prepare phase2 "$POT_CONTRIBUTED" "$POT_FINAL" -v
"$SNARKJS" groth16 setup "$R1CS_FILE" "$POT_FINAL" "$ZKEY_INITIAL"
"$SNARKJS" zkey contribute \
    "$ZKEY_INITIAL" \
    "$ZKEY_FINAL" \
    --name="local-development-contribution" \
    -v \
    -e="cross-chain-local-development-zkey"
"$SNARKJS" zkey verify "$R1CS_FILE" "$POT_FINAL" "$ZKEY_FINAL"
"$SNARKJS" zkey export verificationkey "$ZKEY_FINAL" "$VERIFICATION_KEY"

VALID_WITNESS="$PROVING_DIR/valid.wtns"
VALID_PROOF="$PROVING_DIR/proof.json"
VALID_PUBLIC="$PROVING_DIR/public.json"

printf '\n[valid credential proof]\n'
node "$WITNESS_GENERATOR" "$WASM_FILE" "$INPUT_DIR/valid.json" "$VALID_WITNESS"
"$SNARKJS" wtns check "$R1CS_FILE" "$VALID_WITNESS"
"$SNARKJS" groth16 prove "$ZKEY_FINAL" "$VALID_WITNESS" "$VALID_PROOF" "$VALID_PUBLIC"
"$SNARKJS" groth16 verify "$VERIFICATION_KEY" "$VALID_PUBLIC" "$VALID_PROOF"
printf 'Verified valid credential proof.\n'

verify_policy_proof "application-alternate-issuer"
verify_policy_proof "application-auditor-role"
verify_policy_proof "valid-replay"
verify_policy_proof "application-next-epoch"
verify_policy_proof "application-alternate-domain"
verify_policy_proof "application-other-action"
verify_policy_proof "active-secondary-current"

GENERATED_VERIFIER="$GENERATED_CONTRACTS_DIR/Groth16Verifier.sol"

printf '\n[export Solidity Groth16 verifier]\n'
"$SNARKJS" zkey export solidityverifier "$ZKEY_FINAL" "$GENERATED_VERIFIER"

printf '\n[prepare Solidity proof fixtures and calldata]\n'
node "$SCRIPT_DIR/build-solidity-fixtures.mjs"

expect_witness_rejection "invalid-witness"
expect_witness_rejection "expired"
expect_witness_rejection "wrong-role"
expect_witness_rejection "untrusted-issuer"
expect_witness_rejection "wrong-merkle-path"
expect_witness_rejection "wrong-state-root"
expect_witness_rejection "wrong-nullifier"
expect_witness_rejection "revoked-current"
printf 'EXPECTED FAILURE: revoked credential remains rejected\n'

TAMPERED_PUBLIC="$PROVING_DIR/public-tampered.json"

printf '\n[expected proof rejection: tampered public commitment]\n'
node "$SCRIPT_DIR/tamper-public.mjs" "$VALID_PUBLIC" "$TAMPERED_PUBLIC" "$SCALAR_FIELD_PRIME"

if "$SNARKJS" groth16 verify "$VERIFICATION_KEY" "$TAMPERED_PUBLIC" "$VALID_PROOF"; then
    fail "proof unexpectedly verified with a tampered public commitment"
fi

printf 'Verified expected proof rejection: tampered public commitment\n'
printf '\nZK CREDENTIAL STATE AND NULLIFIER VERIFICATION PASSED\n'
