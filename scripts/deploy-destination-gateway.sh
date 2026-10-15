#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHAIN_B_RPC_URL="${CHAIN_B_RPC_URL:-http://127.0.0.1:9545}"
TEMP_DIR=""
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() {
    local result=$?
    trap - EXIT INT TERM
    if [[ -n "$TEMP_DIR" ]]; then
        rm -f -- "$TEMP_DIR/deployment.log"
        rmdir "$TEMP_DIR" 2>/dev/null || true
    fi
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "${VERIFIER_DEPLOYER_KEY:-}" =~ ^0x[[:xdigit:]]{64}$ ]] || fail "VERIFIER_DEPLOYER_KEY must come from operator configuration"
[[ "$(cast chain-id --rpc-url "$CHAIN_B_RPC_URL")" == "2001" ]] || fail "Destination deployment requires Chain B 2001"
for dependency in "${PBFT_CERTIFICATE_VERIFIER_ADDRESS:-}" "${MERKLE_INCLUSION_VERIFIER_ADDRESS:-}" "${MESSAGE_DOMAIN_VERIFIER_ADDRESS:-}"; do
    [[ "$dependency" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "missing verifier address"
    [[ "$(cast code "$dependency" --rpc-url "$CHAIN_B_RPC_URL")" != "0x" ]] || fail "verifier has no bytecode"
done
[[ "$(cast call "$MESSAGE_DOMAIN_VERIFIER_ADDRESS" 'destinationDomain()(uint256)' --rpc-url "$CHAIN_B_RPC_URL")" == "2001" ]] || fail "domain verifier must bind 2001"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cross-chain-destination.XXXXXX")"
cd "$PROJECT_ROOT/contracts"

deploy() {
    local component="$1"
    shift
    forge create "$component" --rpc-url "$CHAIN_B_RPC_URL" --private-key "$VERIFIER_DEPLOYER_KEY" \
        --broadcast --constructor-args "$@" 2>&1 | tee "$TEMP_DIR/deployment.log"
    DEPLOYED_ADDRESS="$(sed -nE 's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' "$TEMP_DIR/deployment.log" | tail -n 1)"
    [[ "$DEPLOYED_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "missing deployed address"
    [[ "$(cast code "$DEPLOYED_ADDRESS" --rpc-url "$CHAIN_B_RPC_URL")" != "0x" ]] || fail "deployed component has no code"
}
deploy 'src/DestinationGateway.sol:DestinationGateway' "$PBFT_CERTIFICATE_VERIFIER_ADDRESS" "$MERKLE_INCLUSION_VERIFIER_ADDRESS" "$MESSAGE_DOMAIN_VERIFIER_ADDRESS"
DESTINATION_GATEWAY_ADDRESS="$DEPLOYED_ADDRESS"
deploy 'src/ApplicationB.sol:ApplicationB' "$DESTINATION_GATEWAY_ADDRESS"
APPLICATION_B_ADDRESS="$DEPLOYED_ADDRESS"
BOUND_GATEWAY="$(cast call "$APPLICATION_B_ADDRESS" 'destinationGateway()(address)' --rpc-url "$CHAIN_B_RPC_URL")"
[[ "$(printf '%s' "$BOUND_GATEWAY" | tr '[:upper:]' '[:lower:]')" == "$(printf '%s' "$DESTINATION_GATEWAY_ADDRESS" | tr '[:upper:]' '[:lower:]')" ]] || fail "Application B Gateway binding mismatch"
printf 'Production DestinationGateway: %s\nProduction ApplicationB: %s\nApplicationB trusted Gateway: %s\n' "$DESTINATION_GATEWAY_ADDRESS" "$APPLICATION_B_ADDRESS" "$BOUND_GATEWAY"
printf 'PBFTCertificateVerifier: %s\nMerkleInclusionVerifier: %s\nMessageDomainVerifier: %s\n' "$PBFT_CERTIFICATE_VERIFIER_ADDRESS" "$MERKLE_INCLUSION_VERIFIER_ADDRESS" "$MESSAGE_DOMAIN_VERIFIER_ADDRESS"
if [[ -n "${DEPLOYMENT_OUTPUT_FILE:-}" ]]; then
    printf 'DESTINATION_GATEWAY_ADDRESS=%s\nPRODUCTION_APPLICATION_B_ADDRESS=%s\n' "$DESTINATION_GATEWAY_ADDRESS" "$APPLICATION_B_ADDRESS" > "$DEPLOYMENT_OUTPUT_FILE"
fi
