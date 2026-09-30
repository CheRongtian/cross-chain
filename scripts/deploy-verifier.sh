#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
CALLDATA_DIR="$PROJECT_ROOT/zk/build/proving/solidity-calldata"
CHAIN_A_RPC_URL="${CHAIN_A_RPC_URL:-http://127.0.0.1:4545}"
CHAIN_A_EXPECTED_ID="${CHAIN_A_EXPECTED_ID:-10011}"
VERIFIER_DEPLOYER_KEY="${VERIFIER_DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
APPLICATION_MAX_PROOF_AGE="${APPLICATION_MAX_PROOF_AGE:-3600}"
APPLICATION_SUBMITTER="${APPLICATION_SUBMITTER:-0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266}"
TEMP_DIR=""
LAST_DEPLOYED_ADDRESS=""
LAST_TX_HASH=""

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

normalize() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

timestamp_to_decimal() {
    local encoded_timestamp="$1"
    local decoded_timestamp

    if [[ "$encoded_timestamp" =~ ^[0-9]+$ ]]; then
        printf '%s' "$encoded_timestamp"
        return 0
    fi

    if [[ "$encoded_timestamp" =~ ^0x[[:xdigit:]]+$ ]]; then
        decoded_timestamp="$(cast to-dec "$encoded_timestamp")" || return 1
        printf '%s' "$decoded_timestamp"
        return 0
    fi

    return 1
}

cleanup() {
    local exit_code=$?

    trap - EXIT INT TERM
    set +e

    if [[ -n "$TEMP_DIR" ]] && [[ -d "$TEMP_DIR" ]]; then
        rm -f -- \
            "$TEMP_DIR/generated-verifier.log" \
            "$TEMP_DIR/credential-verifier.log" \
            "$TEMP_DIR/identity-application.log"
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

call_identity_application() {
    cast call "$IDENTITY_APPLICATION_ADDRESS" \
        "verifySupplier(uint256[2],uint256[2][2],uint256[2],uint256,uint256,uint256,uint256)" \
        "$PROOF_A" \
        "$PROOF_B" \
        "$PROOF_C" \
        "$CREDENTIAL_COMMITMENT" \
        "$TRUSTED_ISSUER" \
        "$REQUIRED_ROLE" \
        "$CURRENT_TIMESTAMP" \
        --from "$APPLICATION_SUBMITTER" \
        --rpc-url "$CHAIN_A_RPC_URL"
}

authorization_status() {
    local credential_commitment="$1"

    cast call "$IDENTITY_APPLICATION_ADDRESS" \
        "authorizationStatus(uint256)(uint8)" \
        "$credential_commitment" \
        --rpc-url "$CHAIN_A_RPC_URL"
}

assert_authorization_status() {
    local credential_commitment="$1"
    local expected_status="$2"
    local label="$3"
    local actual_status

    actual_status="$(authorization_status "$credential_commitment")"
    [[ "$(normalize "$actual_status")" == "$(normalize "$expected_status")" ]] \
        || fail "$label: expected status $expected_status, got $actual_status"
    printf 'Verified %s authorization status: %s\n' "$label" "$actual_status"
}

expect_application_revert() {
    local label="$1"
    local error_signature="$2"
    local error_name="${error_signature%%(*}"
    local error_selector
    local output

    error_selector="$(cast sig "$error_signature")"

    if output="$(call_identity_application 2>&1)"; then
        printf '%s\n' "$output"
        fail "$label unexpectedly succeeded"
    fi

    printf '%s\n' "$output"

    if [[ "$(normalize "$output")" != *"$(normalize "$error_selector")"* ]] \
        && [[ "$output" != *"$error_name"* ]]; then
        fail "$label reverted without $error_signature"
    fi

    printf 'Verified expected application rejection: %s (%s)\n' "$label" "$error_name"
}

set_next_block_timestamp() {
    local timestamp="$1"

    cast rpc --rpc-url "$CHAIN_A_RPC_URL" evm_setNextBlockTimestamp "$timestamp" >/dev/null
    cast rpc --rpc-url "$CHAIN_A_RPC_URL" evm_mine >/dev/null
}

send_identity_authorization() {
    local output

    output="$(
        cast send "$IDENTITY_APPLICATION_ADDRESS" \
            "verifySupplier(uint256[2],uint256[2][2],uint256[2],uint256,uint256,uint256,uint256)" \
            "$PROOF_A" \
            "$PROOF_B" \
            "$PROOF_C" \
            "$CREDENTIAL_COMMITMENT" \
            "$TRUSTED_ISSUER" \
            "$REQUIRED_ROLE" \
            "$CURRENT_TIMESTAMP" \
            --rpc-url "$CHAIN_A_RPC_URL" \
            --private-key "$VERIFIER_DEPLOYER_KEY" \
            --async
    )"

    printf 'cast send output: %s\n' "$output"
    LAST_TX_HASH="$(
        printf '%s\n' "$output" \
            | sed -nE 's/.*(0x[[:xdigit:]]{64}).*/\1/p' \
            | tail -n 1
    )"

    [[ "$LAST_TX_HASH" =~ ^0x[[:xdigit:]]{64}$ ]] \
        || fail "could not extract IdentityApplicationA transaction hash"
}

assert_transaction_success() {
    local transaction_hash="$1"
    local label="$2"
    local status

    status="$(cast receipt "$transaction_hash" status --rpc-url "$CHAIN_A_RPC_URL")"

    case "$(normalize "$status")" in
        1|0x1|0x01|true)
            printf 'Verified %s transaction status: %s\n' "$label" "$status"
            ;;
        *)
            fail "$label transaction failed with status '$status'"
            ;;
    esac
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
[[ "$APPLICATION_MAX_PROOF_AGE" =~ ^[1-9][0-9]*$ ]] \
    || fail "APPLICATION_MAX_PROOF_AGE must be a positive integer"

ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$CHAIN_A_RPC_URL")"
[[ "$ACTUAL_CHAIN_ID" == "$CHAIN_A_EXPECTED_ID" ]] \
    || fail "expected Chain A ID $CHAIN_A_EXPECTED_ID, got $ACTUAL_CHAIN_ID"

TEMP_PARENT="${TMPDIR:-/tmp}"
TEMP_DIR="$(mktemp -d "$TEMP_PARENT/cross-chain-verifier-deployment.XXXXXX")"

cd "$CONTRACTS_DIR"

load_calldata "valid"
if ! PROOF_TIMESTAMP_DECIMAL="$(timestamp_to_decimal "$CURRENT_TIMESTAMP")"; then
    fail "valid proof timestamp must be an unsigned decimal or hexadecimal integer"
fi

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

printf '\n[deploy identity application to Chain A]\n'
deploy_contract \
    "src/IdentityApplicationA.sol:IdentityApplicationA" \
    "$TEMP_DIR/identity-application.log" \
    --constructor-args \
    "$CREDENTIAL_VERIFIER_ADDRESS" \
    "$TRUSTED_ISSUER" \
    "$REQUIRED_ROLE" \
    "$APPLICATION_MAX_PROOF_AGE"
IDENTITY_APPLICATION_ADDRESS="$LAST_DEPLOYED_ADDRESS"
printf 'Identity application: %s\n' "$IDENTITY_APPLICATION_ADDRESS"

for deployed_address in \
    "$GROTH16_VERIFIER_ADDRESS" \
    "$CREDENTIAL_VERIFIER_ADDRESS" \
    "$IDENTITY_APPLICATION_ADDRESS"; do
    DEPLOYED_CODE="$(cast code "$deployed_address" --rpc-url "$CHAIN_A_RPC_URL")"
    [[ -n "$DEPLOYED_CODE" ]] && [[ "$DEPLOYED_CODE" != "0x" ]] \
        || fail "no bytecode at deployed address $deployed_address"
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

printf '\n[expected application rejection: future proof timestamp]\n'
load_calldata "valid"
CHAIN_TIMESTAMP="$(cast block latest --field timestamp --rpc-url "$CHAIN_A_RPC_URL")"
[[ "$CHAIN_TIMESTAMP" =~ ^[0-9]+$ ]] || fail "Chain A timestamp must be an unsigned integer"
(( PROOF_TIMESTAMP_DECIMAL > CHAIN_TIMESTAMP )) \
    || fail "proof timestamp $PROOF_TIMESTAMP_DECIMAL must be later than current Chain A timestamp $CHAIN_TIMESTAMP"
expect_application_revert "future proof timestamp" "FutureProofTimestamp()"
assert_authorization_status "$CREDENTIAL_COMMITMENT" "0" "future proof"

FRESH_BLOCK_TIMESTAMP=$((PROOF_TIMESTAMP_DECIMAL + 1))
printf '\n[advance Chain A to fresh proof window: %s]\n' "$FRESH_BLOCK_TIMESTAMP"
set_next_block_timestamp "$FRESH_BLOCK_TIMESTAMP"

printf '\n[expected application rejection: tampered proof]\n'
load_calldata "tampered-proof"
expect_application_revert "tampered proof" "InvalidCredentialProof()"
assert_authorization_status "$CREDENTIAL_COMMITMENT" "0" "tampered proof"

printf '\n[expected application rejection: alternate issuer policy]\n'
load_calldata "application-alternate-issuer"
ALTERNATE_ISSUER_RESULT="$(call_credential_verifier)"
assert_true_result "$ALTERNATE_ISSUER_RESULT"
printf 'Verified alternate issuer proof is cryptographically valid on Chain A.\n'
expect_application_revert "alternate issuer policy" "InvalidIssuerPolicy()"
assert_authorization_status "$CREDENTIAL_COMMITMENT" "0" "alternate issuer policy"

printf '\n[expected application rejection: auditor role policy]\n'
load_calldata "application-auditor-role"
AUDITOR_ROLE_RESULT="$(call_credential_verifier)"
assert_true_result "$AUDITOR_ROLE_RESULT"
printf 'Verified auditor role proof is cryptographically valid on Chain A.\n'
expect_application_revert "auditor role policy" "InvalidRolePolicy()"
assert_authorization_status "$CREDENTIAL_COMMITMENT" "0" "auditor role policy"

printf '\n[valid application authorization]\n'
load_calldata "valid"
send_identity_authorization
assert_transaction_success "$LAST_TX_HASH" "IdentityApplicationA authorization"
assert_authorization_status "$CREDENTIAL_COMMITMENT" "1" "valid supplier proof"

printf '\n[idempotent application authorization]\n'
send_identity_authorization
assert_transaction_success "$LAST_TX_HASH" "duplicate IdentityApplicationA authorization"
assert_authorization_status "$CREDENTIAL_COMMITMENT" "1" "duplicate valid supplier proof"

STALE_BLOCK_TIMESTAMP=$((PROOF_TIMESTAMP_DECIMAL + APPLICATION_MAX_PROOF_AGE + 1))
printf '\n[advance Chain A beyond proof freshness window: %s]\n' "$STALE_BLOCK_TIMESTAMP"
set_next_block_timestamp "$STALE_BLOCK_TIMESTAMP"

printf '\n[expected application rejection: stale proof timestamp]\n'
expect_application_revert "stale proof timestamp" "StaleProofTimestamp()"
assert_authorization_status "$CREDENTIAL_COMMITMENT" "1" "stored supplier authorization after proof becomes stale"

printf '\nON-CHAIN ZK IDENTITY AUTHORIZATION PASSED\n'
