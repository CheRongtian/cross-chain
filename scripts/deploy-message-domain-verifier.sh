#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHAIN_B_RPC_URL="${CHAIN_B_RPC_URL:-http://127.0.0.1:9545}"
LOCAL_DESTINATION_DOMAIN="${LOCAL_DESTINATION_DOMAIN:-2001}"
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

[[ "${VERIFIER_DEPLOYER_KEY:-}" =~ ^0x[[:xdigit:]]{64}$ ]] || fail "VERIFIER_DEPLOYER_KEY must come from the configured operator"
[[ "${REMOTE_GATEWAY_REGISTRY_ADDRESS:-}" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "REMOTE_GATEWAY_REGISTRY_ADDRESS is required"
[[ "$LOCAL_DESTINATION_DOMAIN" =~ ^[1-9][0-9]*$ ]] || fail "LOCAL_DESTINATION_DOMAIN must be an explicit nonzero decimal domain"
ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$ACTUAL_CHAIN_ID" == "2001" ]] || fail "expected Chain B network ID 2001, got $ACTUAL_CHAIN_ID"
REGISTRY_CODE="$(cast code "$REMOTE_GATEWAY_REGISTRY_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")"
[[ -n "$REGISTRY_CODE" ]] && [[ "$REGISTRY_CODE" != "0x" ]] || fail "remote registry has no bytecode"

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cross-chain-message-domain.XXXXXX")"
cd "$PROJECT_ROOT/contracts"
printf '\n[deploy MessageDomainVerifier for explicit protocol domain %s]\n' "$LOCAL_DESTINATION_DOMAIN"
forge create "src/MessageDomainVerifier.sol:MessageDomainVerifier" \
    --rpc-url "$CHAIN_B_RPC_URL" --private-key "$VERIFIER_DEPLOYER_KEY" \
    --broadcast --constructor-args "$REMOTE_GATEWAY_REGISTRY_ADDRESS" "$LOCAL_DESTINATION_DOMAIN" \
    2>&1 | tee "$TEMP_DIR/verifier-deployment.log"
MESSAGE_DOMAIN_VERIFIER_ADDRESS="$(sed -nE \
    's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' \
    "$TEMP_DIR/verifier-deployment.log" | tail -n 1)"
[[ "$MESSAGE_DOMAIN_VERIFIER_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "could not extract message-domain verifier address"
VERIFIER_CODE="$(cast code "$MESSAGE_DOMAIN_VERIFIER_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")"
[[ -n "$VERIFIER_CODE" ]] && [[ "$VERIFIER_CODE" != "0x" ]] || fail "message-domain verifier has no bytecode"
BOUND_REGISTRY="$(cast call "$MESSAGE_DOMAIN_VERIFIER_ADDRESS" "remoteGatewayRegistry()(address)" --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$(printf '%s' "$BOUND_REGISTRY" | tr '[:upper:]' '[:lower:]')" \
    == "$(printf '%s' "$REMOTE_GATEWAY_REGISTRY_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]] || fail "remote registry binding drift"
BOUND_DOMAIN="$(cast call "$MESSAGE_DOMAIN_VERIFIER_ADDRESS" "destinationDomain()(uint256)" --rpc-url "$CHAIN_B_RPC_URL" | awk '{print $1}')"
[[ "$BOUND_DOMAIN" == "$LOCAL_DESTINATION_DOMAIN" ]] || fail "local protocol domain binding drift"
printf 'Chain B MessageDomainVerifier deployed: %s\n' "$MESSAGE_DOMAIN_VERIFIER_ADDRESS"
printf 'Explicit destination protocol domain: %s\n' "$BOUND_DOMAIN"
if [[ -n "${DEPLOYMENT_OUTPUT_FILE:-}" ]]; then
    printf 'MESSAGE_DOMAIN_VERIFIER_ADDRESS=%s\n' "$MESSAGE_DOMAIN_VERIFIER_ADDRESS" > "$DEPLOYMENT_OUTPUT_FILE"
fi
