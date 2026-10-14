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
ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$ACTUAL_CHAIN_ID" == "2001" ]] || fail "expected Chain B ID 2001, got $ACTUAL_CHAIN_ID"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cross-chain-merkle-verifier.XXXXXX")"
cd "$PROJECT_ROOT/contracts"
printf '\n[deploy MerkleInclusionVerifier to Chain B]\n'
forge create "src/MerkleInclusionVerifier.sol:MerkleInclusionVerifier" \
    --rpc-url "$CHAIN_B_RPC_URL" --private-key "$VERIFIER_DEPLOYER_KEY" \
    --broadcast 2>&1 | tee "$TEMP_DIR/verifier-deployment.log"
MERKLE_INCLUSION_VERIFIER_ADDRESS="$(sed -nE \
    's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' \
    "$TEMP_DIR/verifier-deployment.log" | tail -n 1)"
[[ "$MERKLE_INCLUSION_VERIFIER_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "could not extract Merkle inclusion verifier address"
VERIFIER_CODE="$(cast code "$MERKLE_INCLUSION_VERIFIER_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")"
[[ -n "$VERIFIER_CODE" ]] && [[ "$VERIFIER_CODE" != "0x" ]] || fail "Merkle inclusion verifier has no bytecode"
printf 'Chain B MerkleInclusionVerifier deployed: %s\n' "$MERKLE_INCLUSION_VERIFIER_ADDRESS"
if [[ -n "${DEPLOYMENT_OUTPUT_FILE:-}" ]]; then
    printf 'MERKLE_INCLUSION_VERIFIER_ADDRESS=%s\n' "$MERKLE_INCLUSION_VERIFIER_ADDRESS" > "$DEPLOYMENT_OUTPUT_FILE"
fi
