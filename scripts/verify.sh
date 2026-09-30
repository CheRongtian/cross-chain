#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
LOG_FILE="$PROJECT_ROOT/verification.log"
VERIFICATION_NAME="Cross-Chain Protocol Verification"

CHAIN_A_RPC="http://127.0.0.1:4545"
CHAIN_B_RPC="http://127.0.0.1:9545"
CHAIN_A_ID="10011"
CHAIN_B_ID="2001"

ANVIL_DEV_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
SOURCE_SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
DESTINATION_RECEIVER="0x000000000000000000000000000000000000bEEF"
ZERO_ADDRESS="0x0000000000000000000000000000000000000000"
PAYLOAD="0x68656c6c6f20636861696e2062"
EXPECTED_PAYLOAD_TEXT="hello chain b"
EXPECTED_PAYLOAD_HASH="0x758a9838e83061770f5b75d8544bc7a27cc795a8741c6b50bdf738ee276d23a6"
EVENT_SIGNATURE="CrossChainMessage(bytes32,uint8,uint256,address,address,uint256,address,uint256,bytes)"

STARTED_CHAINS="false"
CHAINS_PID=""
TEMP_DIR=""
CURRENT_STEP="initialization"
LAST_TX_HASH=""

: > "$LOG_FILE"
exec > >(tee "$LOG_FILE") 2>&1

normalize() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

fail() {
    printf '\nERROR: %s\n' "$*" >&2
    exit 1
}

assert_equal() {
    local actual="$1"
    local expected="$2"
    local label="$3"

    if [[ "$actual" != "$expected" ]]; then
        fail "$label: expected '$expected', got '$actual'"
    fi

    printf 'Verified %s: %s\n' "$label" "$actual"
}

assert_hex_equal() {
    local actual
    local expected
    local label="$3"

    actual="$(normalize "$1")"
    expected="$(normalize "$2")"

    if [[ "$actual" != "$expected" ]]; then
        fail "$label: expected '$expected', got '$actual'"
    fi

    printf 'Verified %s: %s\n' "$label" "$actual"
}

probe_chain_id() {
    local rpc_url="$1"
    local result

    if result="$(cast chain-id --rpc-url "$rpc_url" 2>/dev/null)"; then
        printf '%s' "$result"
    fi
}

wait_for_chain() {
    local label="$1"
    local rpc_url="$2"
    local expected_chain_id="$3"
    local actual_chain_id=""
    local attempt

    for attempt in {1..50}; do
        actual_chain_id="$(probe_chain_id "$rpc_url")"

        if [[ "$actual_chain_id" == "$expected_chain_id" ]]; then
            printf '%s is ready with chain ID %s.\n' "$label" "$actual_chain_id"
            return 0
        fi

        if [[ -n "$actual_chain_id" ]]; then
            printf '%s returned unexpected chain ID %s.\n' "$label" "$actual_chain_id" >&2
            return 1
        fi

        if [[ -n "$CHAINS_PID" ]] && ! kill -0 "$CHAINS_PID" 2>/dev/null; then
            printf '%s exited before %s became ready.\n' "$PROJECT_ROOT/scripts/start-chains.sh" "$label" >&2
            return 1
        fi

        sleep 0.2
    done

    printf 'Timed out waiting for %s at %s.\n' "$label" "$rpc_url" >&2
    return 1
}

assert_transaction_success() {
    local transaction_hash="$1"
    local label="$2"
    local status

    status="$(cast receipt "$transaction_hash" status --rpc-url "$CHAIN_A_RPC")"

    case "$(normalize "$status")" in
        1|0x1|0x01|true)
            printf 'Verified %s transaction status: %s\n' "$label" "$status"
            ;;
        *)
            fail "$label transaction failed with status '$status'"
            ;;
    esac
}

send_message() {
    local output

    output="$(
        cast send "$SOURCE_GATEWAY" \
            "sendMessage(uint256,address,bytes)" \
            "$CHAIN_B_ID" \
            "$DESTINATION_RECEIVER" \
            "$PAYLOAD" \
            --rpc-url "$CHAIN_A_RPC" \
            --private-key "$ANVIL_DEV_KEY" \
            --async
    )"

    printf 'cast send output: %s\n' "$output"

    LAST_TX_HASH="$(
        printf '%s\n' "$output" \
            | sed -nE 's/.*(0x[[:xdigit:]]{64}).*/\1/p' \
            | tail -n 1
    )"

    if [[ ! "$LAST_TX_HASH" =~ ^0x[[:xdigit:]]{64}$ ]]; then
        fail "could not extract transaction hash from cast send output"
    fi

    printf 'Transaction hash: %s\n' "$LAST_TX_HASH"
}

verify_message_event() {
    local transaction_hash="$1"
    local expected_message_id="$2"
    local expected_nonce="$3"
    local label="$4"
    local block_number
    local receipt_json
    local normalized_receipt
    local event_topic
    local sender_topic
    local destination_domain_topic
    local expected_data
    local expected_value

    printf '\nReceipt for %s:\n' "$label"
    cast receipt "$transaction_hash" --rpc-url "$CHAIN_A_RPC"
    assert_transaction_success "$transaction_hash" "$label"

    block_number="$(cast receipt "$transaction_hash" blockNumber --rpc-url "$CHAIN_A_RPC")"
    printf '\nDecoded logs for %s at block %s:\n' "$label" "$block_number"
    cast logs \
        --rpc-url "$CHAIN_A_RPC" \
        --address "$SOURCE_GATEWAY" \
        --from-block "$block_number" \
        --to-block "$block_number" \
        "$EVENT_SIGNATURE"

    receipt_json="$(cast rpc eth_getTransactionReceipt "$transaction_hash" --rpc-url "$CHAIN_A_RPC")"
    normalized_receipt="$(normalize "$receipt_json")"

    event_topic="$(cast keccak "$EVENT_SIGNATURE")"
    sender_topic="$(cast abi-encode "f(address)" "$SOURCE_SENDER")"
    destination_domain_topic="$(cast abi-encode "f(uint256)" "$CHAIN_B_ID")"
    expected_data="$(
        cast abi-encode \
            "f(uint8,uint256,address,address,uint256,bytes)" \
            1 \
            "$CHAIN_A_ID" \
            "$SOURCE_GATEWAY" \
            "$DESTINATION_RECEIVER" \
            "$expected_nonce" \
            "$PAYLOAD"
    )"

    for expected_value in \
        "$SOURCE_GATEWAY" \
        "$event_topic" \
        "$expected_message_id" \
        "$sender_topic" \
        "$destination_domain_topic" \
        "$expected_data"; do
        if [[ "$normalized_receipt" != *"$(normalize "$expected_value")"* ]]; then
            fail "$label receipt does not contain expected event value '$expected_value'"
        fi
    done

    printf 'Verified %s CrossChainMessage fields and canonical message ID.\n' "$label"
}

cleanup() {
    local exit_code=$?

    trap - EXIT INT TERM
    set +e

    if [[ "$STARTED_CHAINS" == "true" ]] && [[ -n "$CHAINS_PID" ]]; then
        printf '\nStopping the local chains started by this verification...\n'
        kill "$CHAINS_PID" 2>/dev/null || true
        wait "$CHAINS_PID" 2>/dev/null || true
    fi

    if [[ -n "$TEMP_DIR" ]] && [[ -d "$TEMP_DIR" ]]; then
        rm -f -- "$TEMP_DIR/deploy-output.log"
        rmdir "$TEMP_DIR" 2>/dev/null || true
    fi

    if [[ "$exit_code" -eq 0 ]]; then
        printf '\n========================================\n'
        printf 'VERIFICATION PASSED\n'
        printf 'On-chain ZK Credential Verification\n'
        printf '========================================\n'
    else
        printf '\n========================================\n' >&2
        printf 'VERIFICATION FAILED during: %s (exit code %s)\n' "$CURRENT_STEP" "$exit_code" >&2
        printf 'On-chain ZK Credential Verification\n' >&2
        printf '========================================\n' >&2
    fi

    exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '========================================\n'
printf '%s\n' "$VERIFICATION_NAME"
printf 'On-chain ZK Credential Verification\n'
printf '========================================\n'
printf 'Verification time: %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"
printf 'Project root: %s\n' "$PROJECT_ROOT"
printf 'Contracts directory: %s\n' "$CONTRACTS_DIR"
printf 'Log file: %s\n' "$LOG_FILE"

if [[ -e "$PROJECT_ROOT/.git" ]]; then
    printf '\nGit information:\n'

    if command -v git >/dev/null 2>&1; then
        printf 'Commit: %s\n' "$(git -C "$PROJECT_ROOT" rev-parse HEAD)"

        if branch="$(git -C "$PROJECT_ROOT" symbolic-ref --quiet --short HEAD)"; then
            printf 'Branch: %s\n' "$branch"
        else
            printf 'Branch: detached HEAD\n'
        fi

        printf 'Working tree:\n'
        git -C "$PROJECT_ROOT" status --short
    else
        printf 'Project has Git metadata, but the git executable is unavailable.\n'
    fi
else
    printf '\nGit information: project root has no local .git metadata.\n'
fi

printf '\nVerification steps:\n'
printf '  1. Validate the credential model and fixtures\n'
printf '  2. Compile the ZK circuit and verify local proof cases\n'
printf '  3. Export the Solidity Groth16 verifier and proof fixtures\n'
printf '  4. Format generated Solidity sources\n'
printf '  5. forge fmt --check\n'
printf '  6. forge build\n'
printf '  7. forge test -vv\n'
printf '  8. Run focused canonical-message and credential-verifier tests\n'
printf '  9. Check or start Chain A and Chain B\n'
printf ' 10. Verify chain IDs\n'
printf ' 11. Deploy and verify the Groth16 verifier on Chain A\n'
printf ' 12. Deploy SourceGateway to Chain A\n'
printf ' 13. Verify deployment and initial state\n'
printf ' 14. Verify payload text and payload hash\n'
printf ' 15. Predict, send, and verify two messages\n'
printf ' 16. Verify nonce progression\n'
printf ' 17. Verify invalid destination domain and receiver reverts\n'

CURRENT_STEP="credential model validation"
printf '\n[%s]\n' "$CURRENT_STEP"
cd "$PROJECT_ROOT"
python3 "$PROJECT_ROOT/zk/credential-model/validate.py"

CURRENT_STEP="ZK circuit verification and Solidity verifier export"
printf '\n[%s]\n' "$CURRENT_STEP"
bash "$PROJECT_ROOT/zk/scripts/verify-circuit.sh"

cd "$CONTRACTS_DIR"

CURRENT_STEP="generated Solidity source formatting"
printf '\n[%s]\n' "$CURRENT_STEP"
forge fmt generated/Groth16Verifier.sol generated/CredentialProofFixture.sol

CURRENT_STEP="forge fmt --check"
printf '\n[%s]\n' "$CURRENT_STEP"
forge fmt --check

CURRENT_STEP="forge build"
printf '\n[%s]\n' "$CURRENT_STEP"
forge build

CURRENT_STEP="forge test -vv"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test -vv

CURRENT_STEP="canonical gateway encoding test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testGatewayUsesCanonicalMessageIdEncoding -vvv

CURRENT_STEP="identity field separation test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testEveryIdentityFieldChangesMessageId -vvv

CURRENT_STEP="shared golden vector test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testSharedGoldenVectorsMatchCanonicalEncoding -vvv

CURRENT_STEP="event consistency test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testEmitsCrossChainMessage -vvv

CURRENT_STEP="credential verifier tests"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-contract CredentialVerifierTest -vvv

CURRENT_STEP="local chain availability check"
printf '\n[%s]\n' "$CURRENT_STEP"

CHAIN_A_CURRENT_ID="$(probe_chain_id "$CHAIN_A_RPC")"
CHAIN_B_CURRENT_ID="$(probe_chain_id "$CHAIN_B_RPC")"

if [[ -z "$CHAIN_A_CURRENT_ID" ]] && [[ -z "$CHAIN_B_CURRENT_ID" ]]; then
    printf 'No local chains detected; starting them with scripts/start-chains.sh.\n'
    "$PROJECT_ROOT/scripts/start-chains.sh" &
    CHAINS_PID=$!
    STARTED_CHAINS="true"

    wait_for_chain "Chain A" "$CHAIN_A_RPC" "$CHAIN_A_ID"
    wait_for_chain "Chain B" "$CHAIN_B_RPC" "$CHAIN_B_ID"
elif [[ -n "$CHAIN_A_CURRENT_ID" ]] && [[ -n "$CHAIN_B_CURRENT_ID" ]]; then
    assert_equal "$CHAIN_A_CURRENT_ID" "$CHAIN_A_ID" "Chain A ID"
    assert_equal "$CHAIN_B_CURRENT_ID" "$CHAIN_B_ID" "Chain B ID"
    printf 'Using the existing local chains; they will remain running after verification.\n'
else
    fail "only one expected local chain is reachable; start or stop both chains before retrying"
fi

CURRENT_STEP="chain ID verification"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal "$(cast chain-id --rpc-url "$CHAIN_A_RPC")" "$CHAIN_A_ID" "Chain A ID"
assert_equal "$(cast chain-id --rpc-url "$CHAIN_B_RPC")" "$CHAIN_B_ID" "Chain B ID"

CURRENT_STEP="on-chain Groth16 credential verification"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_A_RPC_URL="$CHAIN_A_RPC" \
CHAIN_A_EXPECTED_ID="$CHAIN_A_ID" \
VERIFIER_DEPLOYER_KEY="$ANVIL_DEV_KEY" \
    bash "$PROJECT_ROOT/scripts/deploy-verifier.sh"

CURRENT_STEP="SourceGateway deployment"
printf '\n[%s]\n' "$CURRENT_STEP"

TEMP_PARENT="${TMPDIR:-/tmp}"
TEMP_DIR="$(mktemp -d "$TEMP_PARENT/cross-chain-verification.XXXXXX")"
DEPLOY_OUTPUT_FILE="$TEMP_DIR/deploy-output.log"

forge create src/SourceGateway.sol:SourceGateway \
    --rpc-url "$CHAIN_A_RPC" \
    --private-key "$ANVIL_DEV_KEY" \
    --broadcast \
    2>&1 | tee "$DEPLOY_OUTPUT_FILE"

SOURCE_GATEWAY="$(
    sed -nE 's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' "$DEPLOY_OUTPUT_FILE" \
        | tail -n 1
)"
DEPLOY_TX_HASH="$(
    sed -nE 's/^[[:space:]]*Transaction hash:[[:space:]]*(0x[[:xdigit:]]{64}).*$/\1/p' "$DEPLOY_OUTPUT_FILE" \
        | tail -n 1
)"

if [[ ! "$SOURCE_GATEWAY" =~ ^0x[[:xdigit:]]{40}$ ]]; then
    fail "could not extract the SourceGateway deployment address"
fi

if [[ ! "$DEPLOY_TX_HASH" =~ ^0x[[:xdigit:]]{64}$ ]]; then
    fail "could not extract the SourceGateway deployment transaction hash"
fi

printf 'SourceGateway: %s\n' "$SOURCE_GATEWAY"
printf 'Deployment transaction: %s\n' "$DEPLOY_TX_HASH"
assert_transaction_success "$DEPLOY_TX_HASH" "SourceGateway deployment"

CURRENT_STEP="deployment code verification"
printf '\n[%s]\n' "$CURRENT_STEP"
DEPLOYED_CODE="$(cast code "$SOURCE_GATEWAY" --rpc-url "$CHAIN_A_RPC")"

if [[ -z "$DEPLOYED_CODE" ]] || [[ "$DEPLOYED_CODE" == "0x" ]]; then
    fail "SourceGateway address has no deployed bytecode"
fi

printf 'Verified deployed bytecode at %s.\n' "$SOURCE_GATEWAY"

CURRENT_STEP="initial contract state verification"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "MESSAGE_VERSION()(uint8)" --rpc-url "$CHAIN_A_RPC")" \
    "1" \
    "message version"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "1" \
    "initial nonce"

CURRENT_STEP="payload verification"
printf '\n[%s]\n' "$CURRENT_STEP"
PAYLOAD_TEXT="$(cast to-utf8 "$PAYLOAD")"
assert_equal "$PAYLOAD_TEXT" "$EXPECTED_PAYLOAD_TEXT" "payload UTF-8 text"

PAYLOAD_HASH="$(cast keccak "$PAYLOAD")"
assert_hex_equal "$PAYLOAD_HASH" "$EXPECTED_PAYLOAD_HASH" "payload hash"

CURRENT_STEP="first message ID prediction"
printf '\n[%s]\n' "$CURRENT_STEP"
FIRST_EXPECTED_MESSAGE_ID="$(
    cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,uint256,bytes32)(bytes32)" \
        "$SOURCE_SENDER" \
        "$CHAIN_B_ID" \
        "$DESTINATION_RECEIVER" \
        1 \
        "$PAYLOAD_HASH" \
        --rpc-url "$CHAIN_A_RPC"
)"
printf 'First expected message ID: %s\n' "$FIRST_EXPECTED_MESSAGE_ID"

CURRENT_STEP="first message send"
printf '\n[%s]\n' "$CURRENT_STEP"
send_message
FIRST_TX_HASH="$LAST_TX_HASH"

CURRENT_STEP="first message event verification"
verify_message_event "$FIRST_TX_HASH" "$FIRST_EXPECTED_MESSAGE_ID" 1 "first message"

CURRENT_STEP="nonce verification after first message"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "2" \
    "nonce after first message"

CURRENT_STEP="second message ID prediction"
printf '\n[%s]\n' "$CURRENT_STEP"
SECOND_EXPECTED_MESSAGE_ID="$(
    cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,uint256,bytes32)(bytes32)" \
        "$SOURCE_SENDER" \
        "$CHAIN_B_ID" \
        "$DESTINATION_RECEIVER" \
        2 \
        "$PAYLOAD_HASH" \
        --rpc-url "$CHAIN_A_RPC"
)"
printf 'Second expected message ID: %s\n' "$SECOND_EXPECTED_MESSAGE_ID"

if [[ "$(normalize "$FIRST_EXPECTED_MESSAGE_ID")" == "$(normalize "$SECOND_EXPECTED_MESSAGE_ID")" ]]; then
    fail "different nonces produced identical message IDs"
fi

printf 'Verified that nonce 1 and nonce 2 produce different message IDs.\n'

CURRENT_STEP="second message send"
printf '\n[%s]\n' "$CURRENT_STEP"
send_message
SECOND_TX_HASH="$LAST_TX_HASH"

CURRENT_STEP="second message event verification"
verify_message_event "$SECOND_TX_HASH" "$SECOND_EXPECTED_MESSAGE_ID" 2 "second message"

CURRENT_STEP="nonce verification after second message"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "3" \
    "nonce after second message"

CURRENT_STEP="same-chain destination rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
if cast call "$SOURCE_GATEWAY" \
    "sendMessage(uint256,address,bytes)(bytes32,uint256)" \
    "$CHAIN_A_ID" \
    "$DESTINATION_RECEIVER" \
    "$PAYLOAD" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"; then
    fail "same-chain destination call unexpectedly succeeded"
else
    printf 'Verified rejection of the source domain as destination domain.\n'
fi

CURRENT_STEP="zero destination receiver rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
if cast call "$SOURCE_GATEWAY" \
    "sendMessage(uint256,address,bytes)(bytes32,uint256)" \
    "$CHAIN_B_ID" \
    "$ZERO_ADDRESS" \
    "$PAYLOAD" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"; then
    fail "zero destination receiver call unexpectedly succeeded"
else
    printf 'Verified rejection of the zero destination receiver.\n'
fi

CURRENT_STEP="complete"
