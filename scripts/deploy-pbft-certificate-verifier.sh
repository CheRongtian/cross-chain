#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHAIN_B_RPC_URL="${CHAIN_B_RPC_URL:-http://127.0.0.1:9545}"
TEMP_DIR=""

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    local exit_code=$?
    trap - EXIT INT TERM
    set +e
    if [[ -n "$TEMP_DIR" ]] && [[ -d "$TEMP_DIR" ]]; then
        rm -f -- "$TEMP_DIR/verifier-deployment.log"
        rmdir "$TEMP_DIR" 2>/dev/null || true
    fi
    exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "${VERIFIER_DEPLOYER_KEY:-}" =~ ^0x[[:xdigit:]]{64}$ ]] \
    || fail "VERIFIER_DEPLOYER_KEY must be supplied by the configured operator"
[[ "${VALIDATOR_SET_REGISTRY_ADDRESS:-}" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "VALIDATOR_SET_REGISTRY_ADDRESS must identify the deployed historical registry"
ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$ACTUAL_CHAIN_ID" == "2001" ]] || fail "expected Chain B ID 2001, got $ACTUAL_CHAIN_ID"
REGISTRY_CODE="$(cast code "$VALIDATOR_SET_REGISTRY_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")"
[[ -n "$REGISTRY_CODE" ]] && [[ "$REGISTRY_CODE" != "0x" ]] || fail "historical registry has no bytecode"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cross-chain-pbft-verifier.XXXXXX")"
cd "$PROJECT_ROOT/contracts"
printf '\n[deploy PBFTCertificateVerifier to Chain B]\n'
forge create "src/PBFTCertificateVerifier.sol:PBFTCertificateVerifier" \
    --rpc-url "$CHAIN_B_RPC_URL" --private-key "$VERIFIER_DEPLOYER_KEY" \
    --broadcast --constructor-args "$VALIDATOR_SET_REGISTRY_ADDRESS" \
    2>&1 | tee "$TEMP_DIR/verifier-deployment.log"
PBFT_CERTIFICATE_VERIFIER_ADDRESS="$(sed -nE \
    's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' \
    "$TEMP_DIR/verifier-deployment.log" | tail -n 1)"
[[ "$PBFT_CERTIFICATE_VERIFIER_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "could not extract PBFT verifier address"
VERIFIER_CODE="$(cast code "$PBFT_CERTIFICATE_VERIFIER_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")"
[[ -n "$VERIFIER_CODE" ]] && [[ "$VERIFIER_CODE" != "0x" ]] || fail "PBFT verifier has no bytecode"
BOUND_REGISTRY="$(cast call "$PBFT_CERTIFICATE_VERIFIER_ADDRESS" "validatorSetRegistry()(address)" --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$(printf '%s' "$BOUND_REGISTRY" | tr '[:upper:]' '[:lower:]')" \
    == "$(printf '%s' "$VALIDATOR_SET_REGISTRY_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]] \
    || fail "PBFT verifier is bound to a different registry"
printf 'Chain B PBFTCertificateVerifier deployed: %s\n' "$PBFT_CERTIFICATE_VERIFIER_ADDRESS"
printf 'Immutable historical registry: %s\n' "$BOUND_REGISTRY"
if [[ -n "${DEPLOYMENT_OUTPUT_FILE:-}" ]]; then
    printf 'PBFT_CERTIFICATE_VERIFIER_ADDRESS=%s\n' "$PBFT_CERTIFICATE_VERIFIER_ADDRESS" > "$DEPLOYMENT_OUTPUT_FILE"
fi
