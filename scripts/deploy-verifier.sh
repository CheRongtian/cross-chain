#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
CALLDATA_DIR="$PROJECT_ROOT/zk/build/proving/solidity-calldata"
CHAIN_A_RPC_URL="${CHAIN_A_RPC_URL:-http://127.0.0.1:4545}"
CHAIN_A_EXPECTED_ID="${CHAIN_A_EXPECTED_ID:-10011}"
VERIFIER_DEPLOYER_KEY="${VERIFIER_DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
TEMP_DIR=""
LAST_DEPLOYED_ADDRESS=""

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

normalize() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

cleanup() {
    local exit_code=$?

    trap - EXIT INT TERM
    set +e

    if [[ -n "$TEMP_DIR" ]] && [[ -d "$TEMP_DIR" ]]; then
        rm -f -- "$TEMP_DIR/generated-verifier.log" "$TEMP_DIR/credential-verifier.log"
        rmdir "$TEMP_DIR" 2>/dev/null || true
    fi

    exit "$exit_code"
}

deploy_contract() {
    local contract_identifier="$1"
    local output_file="$2"
    shift 2

    forge create "$contract_identifier" \
        --rpc-url "$CHAIN_A_RPC_URL" \
        --private-key "$VERIFIER_DEPLOYER_KEY" \
        --broadcast \
        "$@" \
        2>&1 | tee "$output_file"

    LAST_DEPLOYED_ADDRESS="$(
        sed -nE 's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' "$output_file" \
            | tail -n 1
    )"

    if [[ ! "$LAST_DEPLOYED_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]]; then
        fail "could not extract deployed address for $contract_identifier"
    fi
}

load_calldata() {
    local case_name="$1"
    local input_file="$CALLDATA_DIR/$case_name.txt"

    [[ -f "$input_file" ]] || fail "missing Solidity calldata: $input_file"
    [[ "$(wc -l < "$input_file" | tr -d '[:space:]')" == "7" ]] \
        || fail "Solidity calldata must contain seven lines: $input_file"

    PROOF_A="$(sed -n '1p' "$input_file")"
    PROOF_B="$(sed -n '2p' "$input_file")"
    PROOF_C="$(sed -n '3p' "$input_file")"
    CREDENTIAL_COMMITMENT="$(sed -n '4p' "$input_file")"
    TRUSTED_ISSUER="$(sed -n '5p' "$input_file")"
    REQUIRED_ROLE="$(sed -n '6p' "$input_file")"
    CURRENT_TIMESTAMP="$(sed -n '7p' "$input_file")"
}

call_credential_verifier() {
    cast call "$CREDENTIAL_VERIFIER_ADDRESS" \
        "verifyCredentialProof(uint256[2],uint256[2][2],uint256[2],uint256,uint256,uint256,uint256)(bool)" \
        "$PROOF_A" \
        "$PROOF_B" \
        "$PROOF_C" \
        "$CREDENTIAL_COMMITMENT" \
        "$TRUSTED_ISSUER" \
        "$REQUIRED_ROLE" \
        "$CURRENT_TIMESTAMP" \
        --rpc-url "$CHAIN_A_RPC_URL"
}

assert_true_result() {
    local result
    result="$(normalize "$1")"

    case "$result" in
        true|1|0x1|0x01|0x0000000000000000000000000000000000000000000000000000000000000001)
            ;;
        *)
            fail "valid on-chain proof returned '$1'"
            ;;
    esac
}

assert_false_result() {
    local result
    local label="$2"
    result="$(normalize "$1")"

    case "$result" in
        false|0|0x0|0x00|0x0000000000000000000000000000000000000000000000000000000000000000)
            printf 'Verified expected on-chain rejection: %s\n' "$label"
            ;;
        *)
            fail "$label unexpectedly returned '$1'"
            ;;
    esac
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -f "$CONTRACTS_DIR/generated/Groth16Verifier.sol" ]] \
    || fail "generated Groth16 verifier is missing"
[[ -f "$CONTRACTS_DIR/generated/CredentialProofFixture.sol" ]] \
    || fail "generated credential proof fixture is missing"

ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$CHAIN_A_RPC_URL")"
[[ "$ACTUAL_CHAIN_ID" == "$CHAIN_A_EXPECTED_ID" ]] \
    || fail "expected Chain A ID $CHAIN_A_EXPECTED_ID, got $ACTUAL_CHAIN_ID"

TEMP_PARENT="${TMPDIR:-/tmp}"
TEMP_DIR="$(mktemp -d "$TEMP_PARENT/cross-chain-verifier-deployment.XXXXXX")"

cd "$CONTRACTS_DIR"

printf '\n[deploy generated Groth16 verifier to Chain A]\n'
deploy_contract \
    "generated/Groth16Verifier.sol:Groth16Verifier" \
    "$TEMP_DIR/generated-verifier.log"
GROTH16_VERIFIER_ADDRESS="$LAST_DEPLOYED_ADDRESS"
printf 'Generated Groth16 verifier: %s\n' "$GROTH16_VERIFIER_ADDRESS"

printf '\n[deploy credential verifier adapter to Chain A]\n'
deploy_contract \
    "src/CredentialVerifier.sol:CredentialVerifier" \
    "$TEMP_DIR/credential-verifier.log" \
    --constructor-args "$GROTH16_VERIFIER_ADDRESS"
CREDENTIAL_VERIFIER_ADDRESS="$LAST_DEPLOYED_ADDRESS"
printf 'Credential verifier adapter: %s\n' "$CREDENTIAL_VERIFIER_ADDRESS"

for deployed_address in "$GROTH16_VERIFIER_ADDRESS" "$CREDENTIAL_VERIFIER_ADDRESS"; do
    DEPLOYED_CODE="$(cast code "$deployed_address" --rpc-url "$CHAIN_A_RPC_URL")"
    [[ -n "$DEPLOYED_CODE" ]] && [[ "$DEPLOYED_CODE" != "0x" ]] \
        || fail "no bytecode at deployed verifier address $deployed_address"
done

printf '\n[valid on-chain credential proof]\n'
load_calldata "valid"
VALID_RESULT="$(call_credential_verifier)"
assert_true_result "$VALID_RESULT"
printf 'Verified valid Groth16 credential proof on Chain A.\n'

for case_spec in \
    "tampered-proof:tampered proof" \
    "wrong-credential-commitment:wrong credential commitment" \
    "wrong-trusted-issuer:wrong trusted issuer" \
    "wrong-required-role:wrong required role" \
    "wrong-current-timestamp:wrong current timestamp"; do
    CASE_NAME="${case_spec%%:*}"
    CASE_LABEL="${case_spec#*:}"

    printf '\n[expected on-chain rejection: %s]\n' "$CASE_LABEL"
    load_calldata "$CASE_NAME"
    CASE_RESULT="$(call_credential_verifier)"
    assert_false_result "$CASE_RESULT" "$CASE_LABEL"
done

printf '\nON-CHAIN ZK CREDENTIAL VERIFICATION PASSED\n'
