#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
CHAIN_B_RPC_URL="${CHAIN_B_RPC_URL:-http://127.0.0.1:9545}"
REGISTRY_DEPLOYER_KEY="${REGISTRY_DEPLOYER_KEY:-}"
REGISTRY_ADMIN="${REGISTRY_ADMIN:-}"
DEPLOYMENT_OUTPUT_FILE="${DEPLOYMENT_OUTPUT_FILE:-}"
TEMP_DIR=""

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
        rm -f -- "$TEMP_DIR/registry-deployment.log"
        rmdir "$TEMP_DIR" 2>/dev/null || true
    fi
    exit "$exit_code"
}

register_committee() {
    local epoch="$1"
    local members="$2"
    local output
    local transaction_hash
    local status

    output="$(cast send "$VALIDATOR_SET_REGISTRY_ADDRESS" \
        "registerValidatorSet(uint256,address[4])" "$epoch" "$members" \
        --rpc-url "$CHAIN_B_RPC_URL" --private-key "$REGISTRY_DEPLOYER_KEY" --async)"
    transaction_hash="$(printf '%s\n' "$output" \
        | sed -nE 's/.*(0x[[:xdigit:]]{64}).*/\1/p' | tail -n 1)"
    [[ "$transaction_hash" =~ ^0x[[:xdigit:]]{64}$ ]] \
        || fail "could not extract the validator registration transaction hash"
    status="$(cast receipt "$transaction_hash" status --rpc-url "$CHAIN_B_RPC_URL")"
    case "$(normalize "$status")" in
        1|0x1|0x01|true) printf 'Registered validator epoch %s (transaction %s)\n' "$epoch" "$transaction_hash" ;;
        *) fail "validator epoch $epoch registration failed with status '$status'" ;;
    esac
}

read_committee() {
    cast call "$VALIDATOR_SET_REGISTRY_ADDRESS" "getValidatorSet(uint256)" "$1" \
        --rpc-url "$CHAIN_B_RPC_URL"
}

assert_committee() {
    local epoch="$1"
    local members="$2"
    local digest="$3"
    local expected
    local actual

    expected="$(cast abi-encode "f(address[4],uint8,bytes32)" "$members" 3 "$digest")"
    actual="$(read_committee "$epoch")"
    [[ "$(normalize "$actual")" == "$(normalize "$expected")" ]] \
        || fail "validator epoch $epoch canonical members, quorum or digest differ from trusted history"
    printf 'Validator epoch %s:\n  validators = %s\n  quorum = 3\n  committeeDigest = %s\n' \
        "$epoch" "$members" "$digest"
    printf 'VALID: off-chain / Chain B epoch %s committee ordering, quorum and digest match\n' "$epoch"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$REGISTRY_DEPLOYER_KEY" =~ ^0x[[:xdigit:]]{64}$ ]] \
    || fail "REGISTRY_DEPLOYER_KEY must be supplied by the configured operator"
[[ "$REGISTRY_ADMIN" =~ ^0x[[:xdigit:]]{40}$ ]] \
    && [[ "$(normalize "$REGISTRY_ADMIN")" != "0x0000000000000000000000000000000000000000" ]] \
    || fail "REGISTRY_ADMIN must be a configured nonzero EVM address"
[[ "${VALIDATOR_INITIAL_EPOCH:-}" =~ ^[0-9]+$ ]] \
    && [[ "${VALIDATOR_ROTATED_EPOCH:-}" =~ ^[0-9]+$ ]] \
    || fail "validator history epochs must be supplied as exact unsigned decimal uint256 values"
[[ "${VALIDATOR_INITIAL_DIGEST:-}" =~ ^0x[[:xdigit:]]{64}$ ]] \
    && [[ "${VALIDATOR_ROTATED_DIGEST:-}" =~ ^0x[[:xdigit:]]{64}$ ]] \
    || fail "expected historical committee digests must be supplied"
[[ -n "${VALIDATOR_INITIAL_MEMBERS:-}" ]] && [[ -n "${VALIDATOR_ROTATED_MEMBERS:-}" ]] \
    || fail "both trusted four-member historical committees must be supplied"

# Validate ABI widths before creating a registry. Epochs never enter shell integer arithmetic.
cast abi-encode "f(uint256,address[4])" "$VALIDATOR_INITIAL_EPOCH" "$VALIDATOR_INITIAL_MEMBERS" >/dev/null
cast abi-encode "f(uint256,address[4])" "$VALIDATOR_ROTATED_EPOCH" "$VALIDATOR_ROTATED_MEMBERS" >/dev/null
ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$ACTUAL_CHAIN_ID" == "2001" ]] || fail "expected Chain B ID 2001, got $ACTUAL_CHAIN_ID"
DEPLOYER_ADDRESS="$(cast wallet address --private-key "$REGISTRY_DEPLOYER_KEY")"
[[ "$(normalize "$DEPLOYER_ADDRESS")" == "$(normalize "$REGISTRY_ADMIN")" ]] \
    || fail "REGISTRY_ADMIN must match the configured operator signer"

TEMP_PARENT="${TMPDIR:-/tmp}"
TEMP_DIR="$(mktemp -d "$TEMP_PARENT/cross-chain-validator-registry-deployment.XXXXXX")"
cd "$CONTRACTS_DIR"

printf '\n[deploy ValidatorSetRegistry to Chain B]\n'
forge create "src/ValidatorSetRegistry.sol:ValidatorSetRegistry" \
    --rpc-url "$CHAIN_B_RPC_URL" --private-key "$REGISTRY_DEPLOYER_KEY" \
    --broadcast --constructor-args "$REGISTRY_ADMIN" \
    2>&1 | tee "$TEMP_DIR/registry-deployment.log"
VALIDATOR_SET_REGISTRY_ADDRESS="$(sed -nE \
    's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' \
    "$TEMP_DIR/registry-deployment.log" | tail -n 1)"
[[ "$VALIDATOR_SET_REGISTRY_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "could not extract the ValidatorSetRegistry deployment address"
DEPLOYED_CODE="$(cast code "$VALIDATOR_SET_REGISTRY_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")"
[[ -n "$DEPLOYED_CODE" ]] && [[ "$DEPLOYED_CODE" != "0x" ]] \
    || fail "no bytecode at the deployed ValidatorSetRegistry address"
DEPLOYED_ADMIN="$(cast call "$VALIDATOR_SET_REGISTRY_ADDRESS" "registryAdmin()(address)" --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$(normalize "$DEPLOYED_ADMIN")" == "$(normalize "$REGISTRY_ADMIN")" ]] \
    || fail "deployed ValidatorSetRegistry administrator differs from the configured operator"
printf 'Chain B ValidatorSetRegistry deployed: %s\n' "$VALIDATOR_SET_REGISTRY_ADDRESS"
printf 'Registry administrator: %s\n' "$DEPLOYED_ADMIN"

register_committee "$VALIDATOR_INITIAL_EPOCH" "$VALIDATOR_INITIAL_MEMBERS"
assert_committee "$VALIDATOR_INITIAL_EPOCH" "$VALIDATOR_INITIAL_MEMBERS" "$VALIDATOR_INITIAL_DIGEST"
INITIAL_RECORD="$(read_committee "$VALIDATOR_INITIAL_EPOCH")"
register_committee "$VALIDATOR_ROTATED_EPOCH" "$VALIDATOR_ROTATED_MEMBERS"
assert_committee "$VALIDATOR_ROTATED_EPOCH" "$VALIDATOR_ROTATED_MEMBERS" "$VALIDATOR_ROTATED_DIGEST"
[[ "$(normalize "$(read_committee "$VALIDATOR_INITIAL_EPOCH")")" == "$(normalize "$INITIAL_RECORD")" ]] \
    || fail "the initial historical committee changed after rotation"
printf 'VALID: historical epoch %s unchanged after epoch %s registration\n' "$VALIDATOR_INITIAL_EPOCH" "$VALIDATOR_ROTATED_EPOCH"

if [[ -n "$DEPLOYMENT_OUTPUT_FILE" ]]; then
    printf 'VALIDATOR_SET_REGISTRY_ADDRESS=%s\n' "$VALIDATOR_SET_REGISTRY_ADDRESS" > "$DEPLOYMENT_OUTPUT_FILE"
fi
