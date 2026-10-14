#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
CHAIN_B_RPC_URL="${CHAIN_B_RPC_URL:-http://127.0.0.1:9545}"
CHAIN_B_EXPECTED_ID="${CHAIN_B_EXPECTED_ID:-2001}"
REGISTRY_DEPLOYER_KEY="${REGISTRY_DEPLOYER_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"
REGISTRY_ADMIN="${REGISTRY_ADMIN:-0x70997970C51812dc3A010C7d01b50e0d17dc79C8}"
REMOTE_SOURCE_DOMAIN="${REMOTE_SOURCE_DOMAIN:-10011}"
REMOTE_SOURCE_GATEWAY="${REMOTE_SOURCE_GATEWAY:-}"
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

assert_transaction_success() {
    local transaction_hash="$1"
    local label="$2"
    local status

    status="$(cast receipt "$transaction_hash" status --rpc-url "$CHAIN_B_RPC_URL")"
    case "$(normalize "$status")" in
        1|0x1|0x01|true)
            printf 'Verified %s transaction status: %s\n' "$label" "$status"
            ;;
        *)
            fail "$label transaction failed with status '$status'"
            ;;
    esac
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$REMOTE_SOURCE_DOMAIN" =~ ^[0-9]+$ ]] \
    || fail "REMOTE_SOURCE_DOMAIN must be an unsigned decimal uint256"
[[ "$REMOTE_SOURCE_GATEWAY" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "REMOTE_SOURCE_GATEWAY must be an EVM address"
[[ "$(normalize "$REMOTE_SOURCE_GATEWAY")" != "0x0000000000000000000000000000000000000000" ]] \
    || fail "REMOTE_SOURCE_GATEWAY must be nonzero"
[[ "$REGISTRY_ADMIN" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "REGISTRY_ADMIN must be an EVM address"
[[ "$(normalize "$REGISTRY_ADMIN")" != "0x0000000000000000000000000000000000000000" ]] \
    || fail "REGISTRY_ADMIN must be nonzero"

ACTUAL_CHAIN_ID="$(cast chain-id --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$ACTUAL_CHAIN_ID" == "$CHAIN_B_EXPECTED_ID" ]] \
    || fail "expected Chain B ID $CHAIN_B_EXPECTED_ID, got $ACTUAL_CHAIN_ID"

DEPLOYER_ADDRESS="$(cast wallet address --private-key "$REGISTRY_DEPLOYER_KEY")"
[[ "$(normalize "$DEPLOYER_ADDRESS")" == "$(normalize "$REGISTRY_ADMIN")" ]] \
    || fail "REGISTRY_ADMIN must match the REGISTRY_DEPLOYER_KEY signer"

TEMP_PARENT="${TMPDIR:-/tmp}"
TEMP_DIR="$(mktemp -d "$TEMP_PARENT/cross-chain-remote-registry-deployment.XXXXXX")"

cd "$CONTRACTS_DIR"

printf '\n[deploy RemoteGatewayRegistry to Chain B]\n'
forge create "src/RemoteGatewayRegistry.sol:RemoteGatewayRegistry" \
    --rpc-url "$CHAIN_B_RPC_URL" \
    --private-key "$REGISTRY_DEPLOYER_KEY" \
    --broadcast \
    --constructor-args "$REGISTRY_ADMIN" \
    2>&1 | tee "$TEMP_DIR/registry-deployment.log"

REMOTE_GATEWAY_REGISTRY_ADDRESS="$(
    sed -nE 's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' \
        "$TEMP_DIR/registry-deployment.log" \
        | tail -n 1
)"
[[ "$REMOTE_GATEWAY_REGISTRY_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "could not extract the RemoteGatewayRegistry deployment address"

DEPLOYED_CODE="$(cast code "$REMOTE_GATEWAY_REGISTRY_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")"
[[ -n "$DEPLOYED_CODE" ]] && [[ "$DEPLOYED_CODE" != "0x" ]] \
    || fail "no bytecode at deployed RemoteGatewayRegistry address"

DEPLOYED_ADMIN="$(
    cast call "$REMOTE_GATEWAY_REGISTRY_ADDRESS" \
        "registryAdmin()(address)" \
        --rpc-url "$CHAIN_B_RPC_URL"
)"
[[ "$(normalize "$DEPLOYED_ADMIN")" == "$(normalize "$REGISTRY_ADMIN")" ]] \
    || fail "registry admin: expected $REGISTRY_ADMIN, got $DEPLOYED_ADMIN"

printf '\n[register current Chain A SourceGateway as a Chain B remote identity]\n'
SET_OUTPUT="$(
    cast send "$REMOTE_GATEWAY_REGISTRY_ADDRESS" \
        "setRemoteGateway(uint256,address)" \
        "$REMOTE_SOURCE_DOMAIN" \
        "$REMOTE_SOURCE_GATEWAY" \
        --rpc-url "$CHAIN_B_RPC_URL" \
        --private-key "$REGISTRY_DEPLOYER_KEY" \
        --async
)"
SET_TX_HASH="$(
    printf '%s\n' "$SET_OUTPUT" \
        | sed -nE 's/.*(0x[[:xdigit:]]{64}).*/\1/p' \
        | tail -n 1
)"
[[ "$SET_TX_HASH" =~ ^0x[[:xdigit:]]{64}$ ]] \
    || fail "could not extract the remote gateway registration transaction hash"
assert_transaction_success "$SET_TX_HASH" "remote gateway registration"

STORED_GATEWAY="$(
    cast call "$REMOTE_GATEWAY_REGISTRY_ADDRESS" \
        "trustedRemoteGateway(uint256)(address)" \
        "$REMOTE_SOURCE_DOMAIN" \
        --rpc-url "$CHAIN_B_RPC_URL"
)"
[[ "$(normalize "$STORED_GATEWAY")" == "$(normalize "$REMOTE_SOURCE_GATEWAY")" ]] \
    || fail "trusted remote gateway: expected $REMOTE_SOURCE_GATEWAY, got $STORED_GATEWAY"

printf 'Chain B RemoteGatewayRegistry deployed: %s\n' "$REMOTE_GATEWAY_REGISTRY_ADDRESS"
printf 'Registry administrator: %s\n' "$DEPLOYED_ADMIN"
printf 'Trusted remote source domain: %s\n' "$REMOTE_SOURCE_DOMAIN"
printf 'Trusted remote source gateway: %s\n' "$STORED_GATEWAY"

if [[ -n "$DEPLOYMENT_OUTPUT_FILE" ]]; then
    printf 'REMOTE_GATEWAY_REGISTRY_ADDRESS=%s\n' \
        "$REMOTE_GATEWAY_REGISTRY_ADDRESS" \
        > "$DEPLOYMENT_OUTPUT_FILE"
fi
