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
        rm -f -- "$TEMP_DIR/application-deployment.log"
        rmdir "$TEMP_DIR" 2>/dev/null || true
    fi
    exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "${VERIFIER_DEPLOYER_KEY:-}" =~ ^0x[[:xdigit:]]{64}$ ]] || fail "VERIFIER_DEPLOYER_KEY must come from the configured operator"
[[ "$(cast chain-id --rpc-url "$CHAIN_B_RPC_URL")" == "2001" ]] || fail "Application B verification requires Chain B network 2001"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cross-chain-application-b.XXXXXX")"
cd "$PROJECT_ROOT/contracts"

deploy_fixture_component() {
    local contract_name="$1"
    shift
    printf '\n[Application B isolated verification deployment: %s]\n' "$contract_name"
    if [[ "$#" -gt 0 ]]; then
        forge create "$contract_name" --rpc-url "$CHAIN_B_RPC_URL" --private-key "$VERIFIER_DEPLOYER_KEY" \
            --broadcast --constructor-args "$@" 2>&1 | tee "$TEMP_DIR/application-deployment.log"
    else
        forge create "$contract_name" --rpc-url "$CHAIN_B_RPC_URL" --private-key "$VERIFIER_DEPLOYER_KEY" \
            --broadcast 2>&1 | tee "$TEMP_DIR/application-deployment.log"
    fi
    DEPLOYED_FIXTURE_ADDRESS="$(sed -nE \
        's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' \
        "$TEMP_DIR/application-deployment.log" | tail -n 1)"
    [[ "$DEPLOYED_FIXTURE_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "could not extract application fixture address"
    local deployed_code
    deployed_code="$(cast code "$DEPLOYED_FIXTURE_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")"
    [[ -n "$deployed_code" ]] && [[ "$deployed_code" != "0x" ]] || fail "application fixture component has no bytecode"
}

printf 'TEST-ONLY Gateway callers below perform no QC/Merkle/domain/replay acceptance.\n'
deploy_fixture_component "test/mocks/MockDestinationGateway.sol:MockDestinationGateway"
APPLICATION_B_GATEWAY_TEST_ADDRESS="$DEPLOYED_FIXTURE_ADDRESS"
deploy_fixture_component "test/mocks/MockDestinationGateway.sol:MockDestinationGateway"
APPLICATION_B_OTHER_GATEWAY_TEST_ADDRESS="$DEPLOYED_FIXTURE_ADDRESS"
deploy_fixture_component "src/ApplicationB.sol:ApplicationB" "$APPLICATION_B_GATEWAY_TEST_ADDRESS"
APPLICATION_B_ADDRESS="$DEPLOYED_FIXTURE_ADDRESS"
BOUND_GATEWAY="$(cast call "$APPLICATION_B_ADDRESS" "destinationGateway()(address)" --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$(printf '%s' "$BOUND_GATEWAY" | tr '[:upper:]' '[:lower:]')" \
    == "$(printf '%s' "$APPLICATION_B_GATEWAY_TEST_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]] || fail "Application B trusted Gateway binding drift"
printf 'Production Application B deployed on Chain B: %s\n' "$APPLICATION_B_ADDRESS"
printf 'Trusted destination Gateway TEST HARNESS: %s\n' "$APPLICATION_B_GATEWAY_TEST_ADDRESS"
printf 'Untrusted same-code Gateway TEST HARNESS: %s\n' "$APPLICATION_B_OTHER_GATEWAY_TEST_ADDRESS"
printf 'This fixture does not deploy a final DestinationGateway or redirect the production Relayer.\n'
if [[ -n "${DEPLOYMENT_OUTPUT_FILE:-}" ]]; then
    printf 'APPLICATION_B_ADDRESS=%s\nAPPLICATION_B_GATEWAY_TEST_ADDRESS=%s\nAPPLICATION_B_OTHER_GATEWAY_TEST_ADDRESS=%s\n' \
        "$APPLICATION_B_ADDRESS" "$APPLICATION_B_GATEWAY_TEST_ADDRESS" "$APPLICATION_B_OTHER_GATEWAY_TEST_ADDRESS" \
        > "$DEPLOYMENT_OUTPUT_FILE"
fi
