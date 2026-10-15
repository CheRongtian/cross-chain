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
        rm -f -- "$TEMP_DIR/test-deployment.log"
        rmdir "$TEMP_DIR" 2>/dev/null || true
    fi
    exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "${VERIFIER_DEPLOYER_KEY:-}" =~ ^0x[[:xdigit:]]{64}$ ]] || fail "VERIFIER_DEPLOYER_KEY must come from the configured operator"
for dependency in "${PBFT_CERTIFICATE_VERIFIER_ADDRESS:-}" "${MERKLE_INCLUSION_VERIFIER_ADDRESS:-}" \
    "${MESSAGE_DOMAIN_VERIFIER_ADDRESS:-}"; do
    [[ "$dependency" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "all three deployed verification components are required"
done
[[ "${EXPECTED_DESTINATION_GATEWAY:-}" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "EXPECTED_DESTINATION_GATEWAY is required"
[[ "$(cast chain-id --rpc-url "$CHAIN_B_RPC_URL")" == "2001" ]] || fail "test harness must be deployed on Chain B network 2001"
for dependency in "$PBFT_CERTIFICATE_VERIFIER_ADDRESS" "$MERKLE_INCLUSION_VERIFIER_ADDRESS" \
    "$MESSAGE_DOMAIN_VERIFIER_ADDRESS"; do
    dependency_code="$(cast code "$dependency" --rpc-url "$CHAIN_B_RPC_URL")"
    [[ -n "$dependency_code" ]] && [[ "$dependency_code" != "0x" ]] || fail "verification dependency has no bytecode"
done

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cross-chain-replay-test.XXXXXX")"
cd "$PROJECT_ROOT/contracts"

deploy_test_contract() {
    local contract_name="$1"
    shift
    printf '\n[deploy TEST-ONLY %s; not a production DestinationGateway]\n' "$contract_name"
    if [[ "$#" -gt 0 ]]; then
        forge create "$contract_name" --rpc-url "$CHAIN_B_RPC_URL" --private-key "$VERIFIER_DEPLOYER_KEY" \
            --broadcast --constructor-args "$@" 2>&1 | tee "$TEMP_DIR/test-deployment.log"
    else
        forge create "$contract_name" --rpc-url "$CHAIN_B_RPC_URL" --private-key "$VERIFIER_DEPLOYER_KEY" \
            --broadcast 2>&1 | tee "$TEMP_DIR/test-deployment.log"
    fi
    DEPLOYED_TEST_ADDRESS="$(sed -nE \
        's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' \
        "$TEMP_DIR/test-deployment.log" | tail -n 1)"
    [[ "$DEPLOYED_TEST_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "could not extract test contract address"
    local deployed_code
    deployed_code="$(cast code "$DEPLOYED_TEST_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")"
    [[ -n "$deployed_code" ]] && [[ "$deployed_code" != "0x" ]] || fail "test contract has no bytecode"
}

deploy_test_contract "test/mocks/AuthenticatedMessageReplayHarness.sol:AuthenticatedMessageReplayHarness" \
    "$PBFT_CERTIFICATE_VERIFIER_ADDRESS" "$MERKLE_INCLUSION_VERIFIER_ADDRESS" \
    "$MESSAGE_DOMAIN_VERIFIER_ADDRESS" "$EXPECTED_DESTINATION_GATEWAY"
REPLAY_TEST_HARNESS_ADDRESS="$DEPLOYED_TEST_ADDRESS"
deploy_test_contract "test/mocks/ReplayTestReceiver.sol:ReplayTestReceiver"
REPLAY_TEST_RECEIVER_ADDRESS="$DEPLOYED_TEST_ADDRESS"
printf 'Chain B TEST-ONLY authenticated replay harness: %s\n' "$REPLAY_TEST_HARNESS_ADDRESS"
printf 'Chain B TEST-ONLY atomicity receiver: %s\n' "$REPLAY_TEST_RECEIVER_ADDRESS"
printf 'Production Relayer target and transport encoding remain unchanged.\n'
if [[ -n "${DEPLOYMENT_OUTPUT_FILE:-}" ]]; then
    printf 'REPLAY_TEST_HARNESS_ADDRESS=%s\nREPLAY_TEST_RECEIVER_ADDRESS=%s\n' \
        "$REPLAY_TEST_HARNESS_ADDRESS" "$REPLAY_TEST_RECEIVER_ADDRESS" > "$DEPLOYMENT_OUTPUT_FILE"
fi
