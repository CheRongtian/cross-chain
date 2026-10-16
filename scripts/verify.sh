#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
INDEXER_DIR="$PROJECT_ROOT/indexer"
VALIDATOR_DIR="$PROJECT_ROOT/validator"
LOG_FILE="$PROJECT_ROOT/verification.log"
VERIFICATION_NAME="Complete End-to-End Cross-Chain Execution"

ENV_FILE="$PROJECT_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
fi

CHAIN_A_RPC="http://127.0.0.1:4545"
CHAIN_B_RPC="http://127.0.0.1:9545"
CHAIN_A_ID="10011"
CHAIN_B_ID="2001"
ALTERNATE_DESTINATION_DOMAIN="3001"
PROOF_TIMESTAMP_OFFSET="3600"
APPLICATION_MAX_PROOF_AGE="3600"
SNARK_SCALAR_FIELD="21888242871839275222246405745257275088548364400416034343698204186575808495617"
APPLICATION_DOMAIN_NAMESPACE="cross-chain:identity-application-domain:v1"
PUBLIC_INPUTS_SIGNATURE="(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
FORWARD_SIGNATURE="forwardAuthorizedMessage(uint256[2],uint256[2][2],uint256[2],${PUBLIC_INPUTS_SIGNATURE},(uint256,address,address,bytes,uint256))"

ANVIL_DEV_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
SOURCE_SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
CHAIN_B_REGISTRY_ADMIN_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
CHAIN_B_REGISTRY_ADMIN="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
UNAUTHORIZED_CALLER="0x000000000000000000000000000000000000cafe"
DESTINATION_GATEWAY="0x000000000000000000000000000000000000d00d"
ALTERNATE_DESTINATION_GATEWAY="0x000000000000000000000000000000000000d00e"
DESTINATION_RECEIVER="0x000000000000000000000000000000000000bEEF"
REMOTE_NO_CODE_GATEWAY="0x00000000000000000000000000000000000a11ce"
REMOTE_ROTATION_GATEWAY="0x000000000000000000000000000000000000b0b0"
UNKNOWN_REMOTE_DOMAIN="20022"
LARGE_REMOTE_DOMAIN="9007199254740993"
ZERO_ADDRESS="0x0000000000000000000000000000000000000000"
PAYLOAD="0x68656c6c6f20636861696e2062"
EXPECTED_PAYLOAD_TEXT="hello chain b"
EXPECTED_PAYLOAD_HASH="0x758a9838e83061770f5b75d8544bc7a27cc795a8741c6b50bdf738ee276d23a6"
MESSAGE_TYPE="CrossChainMessage(uint8 version,uint256 sourceDomain,address sourceGateway,address sourceSender,uint256 destinationDomain,address destinationGateway,address destinationReceiver,uint256 nonce,bytes32 payloadHash,uint256 deadline)"
EVENT_SIGNATURE="CrossChainMessage(bytes32,uint8,uint256,address,address,uint256,address,address,uint256,bytes,uint256)"

DATABASE_URL="${DATABASE_URL:-}"
INDEXER_DB_SCHEMA="${INDEXER_DB_SCHEMA:-cross_chain_indexer_verification}"
INDEXER_DATABASE_TEST_SCHEMA="cross_chain_indexer_database_verification"
INDEXER_BLOCK_RANGE="${INDEXER_BLOCK_RANGE:-2}"
INDEXER_POLL_INTERVAL_MS="${INDEXER_POLL_INTERVAL_MS:-100}"
readonly FULL_VERIFICATION_FINALITY_BLOCK_DEPTH="2"
# Default only when unset; a supplied empty value must fail profile validation.
FINALITY_BLOCK_DEPTH="${FINALITY_BLOCK_DEPTH-$FULL_VERIFICATION_FINALITY_BLOCK_DEPTH}"
FINALITY_POLL_INTERVAL_MS="${FINALITY_POLL_INTERVAL_MS:-100}"
DESTINATION_CONFIRMATIONS="${DESTINATION_CONFIRMATIONS:-3}"
RPC_REQUEST_TIMEOUT_MS="${RPC_REQUEST_TIMEOUT_MS:-10000}"
RELAYER_LEASE_MS="${RELAYER_LEASE_MS:-60000}"
TX_REBROADCAST_INTERVAL_MS="${TX_REBROADCAST_INTERVAL_MS:-5000}"
TX_REPLACEMENT_AFTER_MS="${TX_REPLACEMENT_AFTER_MS:-60000}"
TX_FEE_BUMP_NUMERATOR="${TX_FEE_BUMP_NUMERATOR:-9}"
TX_FEE_BUMP_DENOMINATOR="${TX_FEE_BUMP_DENOMINATOR:-8}"
TX_MAX_ATTEMPTS="${TX_MAX_ATTEMPTS:-4}"
TX_MAX_FEE_PER_GAS="${TX_MAX_FEE_PER_GAS:-100000000000}"
TX_MAX_PRIORITY_FEE_PER_GAS="${TX_MAX_PRIORITY_FEE_PER_GAS:-10000000000}"

STARTED_CHAINS="false"
CHAINS_PID=""
TEMP_DIR=""
VALIDATOR_PID_FILE=""
RELAYER_PID_FILE=""
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

expect_call_revert() {
    local label="$1"
    local error_signature="$2"
    local error_name="${error_signature%%(*}"
    local error_selector
    local output
    local line
    local decoded_pattern
    local selector_pattern
    local matched="false"
    shift 2

    error_selector="$(cast sig "$error_signature")" || fail "could not derive selector for $error_signature"
    [[ "$error_selector" =~ ^0x[[:xdigit:]]{8}$ ]] || fail "invalid selector for $error_signature"
    error_selector="$(normalize "$error_selector")"
    decoded_pattern="execution reverted:[[:space:]]*$(normalize "$error_name")(\(|[[:space:]]*$)"
    selector_pattern="execution reverted(:[[:space:]]*(custom error[[:space:]]+)?${error_selector}[[:xdigit:]]*([[:space:],\"]|$)|,[[:space:]]*data:[[:space:]]*\"?${error_selector}[[:xdigit:]]*(\"|[[:space:]]|$))"

    if output="$(cast call "$@" 2>&1)"; then
        printf '%s\n' "$output"
        fail "$label unexpectedly succeeded"
    fi

    printf '%s\n' "$output"
    # Match the actual revert reason/data on its own line, not an error name or
    # selector mentioned elsewhere in CLI, transport, or contextual diagnostics.
    while IFS= read -r line; do
        if [[ "$line" =~ $decoded_pattern ]] || [[ "$line" =~ $selector_pattern ]]; then
            matched="true"
            break
        fi
    done <<< "$(normalize "$output")"
    if [[ "$matched" != "true" ]]; then
        fail "$label reverted without $error_signature"
    fi

    printf 'EXPECTED FAILURE: %s (%s)\n' "$label" "$error_name"
}

verify_call_revert_assertions() (
    # This subshell confines the command double to synthetic helper fixtures.
    # No fixture invokes an RPC or replaces any deployed-contract call below.
    trap - EXIT INT TERM
    local expected_selector
    local fixture
    local diagnostic
    local call_status
    local expected_status
    local actual_status
    local output
    expected_selector="$(cast sig 'InvalidDeadline()')" || fail "could not derive fixture selector"
    [[ "$expected_selector" =~ ^0x[[:xdigit:]]{8}$ ]] || fail "invalid fixture selector"

    cast() {
        case "$1" in
            sig) printf '%s\n' "$expected_selector" ;;
            call)
                printf 'synthetic cast stdout: %s\n' "$fixture"
                printf '%s\n' "$diagnostic" >&2
                return "$call_status"
                ;;
            *) return 2 ;;
        esac
    }

    for fixture in decoded selector rpc-data wrong-revert name-prefix transport cli success; do
        call_status=1
        expected_status=1
        case "$fixture" in
            decoded)
                diagnostic='Error: execution reverted: InvalidDeadline'
                expected_status=0
                ;;
            selector)
                diagnostic="Error: execution reverted: custom error $expected_selector, data: \"$expected_selector\""
                expected_status=0
                ;;
            rpc-data)
                diagnostic="Error: server returned an error response: error code 3: execution reverted, data: \"$expected_selector\""
                expected_status=0
                ;;
            wrong-revert)
                diagnostic="Error: execution reverted: InvalidDestinationDomain
Expected InvalidDeadline ($expected_selector) but received a different revert"
                ;;
            name-prefix) diagnostic='Error: execution reverted: InvalidDeadlineExtended' ;;
            transport) diagnostic="Error: connection refused while requesting InvalidDeadline ($expected_selector)" ;;
            cli) diagnostic="error: unexpected argument 'InvalidDeadline' ($expected_selector)" ;;
            success)
                diagnostic='Error: execution reverted: InvalidDeadline'
                call_status=0
                ;;
        esac
        if output="$(expect_call_revert "synthetic $fixture" 'InvalidDeadline()' "$ZERO_ADDRESS" 'fixture()' 2>&1)"; then
            actual_status=0
        else
            actual_status=$?
        fi
        if [[ "$actual_status" != "$expected_status" ]] \
            || [[ "$output" != *"synthetic cast stdout: $fixture"* ]] \
            || [[ "$output" != *"$diagnostic"* ]]; then
            printf '%s\n' "$output"
            fail "revert-helper fixture $fixture returned unexpected status or lost diagnostics"
        fi
        if [[ "$expected_status" == "0" ]]; then
            [[ "$output" == *"EXPECTED FAILURE: synthetic $fixture (InvalidDeadline)"* ]] || fail "fixture $fixture lost exact-revert evidence"
        elif [[ "$output" == *"EXPECTED FAILURE:"* ]]; then
            printf '%s\n' "$output"
            fail "fixture $fixture incorrectly credited an expected policy rejection"
        fi
        printf 'VALID: synthetic revert-helper fixture / %s / exit %s, stdout/stderr preserved\n' "$fixture" "$actual_status"
    done
)

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
    local rpc_url="${3:-$CHAIN_A_RPC}"
    local status

    status="$(cast receipt "$transaction_hash" status --rpc-url "$rpc_url")"

    case "$(normalize "$status")" in
        1|0x1|0x01|true)
            printf 'Verified %s transaction status: %s\n' "$label" "$status"
            ;;
        *)
            fail "$label transaction failed with status '$status'"
            ;;
    esac
}

send_registry_transaction() {
    local function_signature="$1"
    shift
    local output

    output="$(
        cast send "$REMOTE_GATEWAY_REGISTRY" \
            "$function_signature" \
            "$@" \
            --rpc-url "$CHAIN_B_RPC" \
            --private-key "$CHAIN_B_REGISTRY_ADMIN_KEY" \
            --async
    )"
    printf 'cast send output: %s\n' "$output"

    LAST_TX_HASH="$(
        printf '%s\n' "$output" \
            | sed -nE 's/.*(0x[[:xdigit:]]{64}).*/\1/p' \
            | tail -n 1
    )"
    [[ "$LAST_TX_HASH" =~ ^0x[[:xdigit:]]{64}$ ]] \
        || fail "could not extract RemoteGatewayRegistry transaction hash"
    printf 'Transaction hash: %s\n' "$LAST_TX_HASH"
}

send_source_application_authorization() {
    local application="$1"
    local authorized="$2"
    local output

    output="$(
        cast send "$SOURCE_GATEWAY" \
            "setSourceApplicationAuthorization(address,bool)" \
            "$application" \
            "$authorized" \
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
        fail "could not extract source application authorization transaction hash"
    fi

    printf 'Transaction hash: %s\n' "$LAST_TX_HASH"
}

deploy_unknown_source_application() {
    local output

    output="$(
        forge create "test/mocks/MockSourceApplication.sol:MockSourceApplication" \
            --rpc-url "$CHAIN_A_RPC" \
            --private-key "$ANVIL_DEV_KEY" \
            --broadcast \
            2>&1
    )"
    printf '%s\n' "$output"

    UNKNOWN_SOURCE_APPLICATION="$(
        printf '%s\n' "$output" \
            | sed -nE 's/^[[:space:]]*Deployed to:[[:space:]]*(0x[[:xdigit:]]{40}).*$/\1/p' \
            | tail -n 1
    )"
    [[ "$UNKNOWN_SOURCE_APPLICATION" =~ ^0x[[:xdigit:]]{40}$ ]] \
        || fail "could not extract unknown source application address"
}

prepare_application_forwarding() {
    node "$INDEXER_DIR/scripts/build-forwarding-proof.mjs" \
        "$CHAIN_A_RPC" "$IDENTITY_APPLICATION_ADDRESS" "$CHAIN_B_ID" \
        "$DESTINATION_GATEWAY" "$DESTINATION_RECEIVER" "$PAYLOAD" "$MESSAGE_DEADLINE" "$SOURCE_SENDER" \
        "$TEMP_DIR/forwarding-calldata.txt"
    [[ "$(wc -l < "$TEMP_DIR/forwarding-calldata.txt" | tr -d '[:space:]')" == "14" ]] \
        || fail "forwarding calldata must contain fourteen lines"
    FORWARD_PROOF_A="$(sed -n '1p' "$TEMP_DIR/forwarding-calldata.txt")"
    FORWARD_PROOF_B="$(sed -n '2p' "$TEMP_DIR/forwarding-calldata.txt")"
    FORWARD_PROOF_C="$(sed -n '3p' "$TEMP_DIR/forwarding-calldata.txt")"
    FORWARD_PUBLIC_INPUTS="($(sed -n '4,14p' "$TEMP_DIR/forwarding-calldata.txt" | paste -sd ',' -))"
}

send_application_message() {
    local output

    output="$(
        cast send "$IDENTITY_APPLICATION_ADDRESS" \
            "$FORWARD_SIGNATURE" \
            "$FORWARD_PROOF_A" "$FORWARD_PROOF_B" "$FORWARD_PROOF_C" "$FORWARD_PUBLIC_INPUTS" \
            "($CHAIN_B_ID,$DESTINATION_GATEWAY,$DESTINATION_RECEIVER,$PAYLOAD,$MESSAGE_DEADLINE)" \
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

    [[ "$LAST_TX_HASH" =~ ^0x[[:xdigit:]]{64}$ ]] \
        || fail "could not extract IdentityApplicationA message transaction hash"
    printf 'Transaction hash: %s\n' "$LAST_TX_HASH"
}

verify_message_event() {
    local transaction_hash="$1"
    local expected_message_id="$2"
    local expected_nonce="$3"
    local expected_source_sender="$4"
    local expected_deadline="$5"
    local label="$6"
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
    sender_topic="$(cast abi-encode "f(address)" "$expected_source_sender")"
    destination_domain_topic="$(cast abi-encode "f(uint256)" "$CHAIN_B_ID")"
    expected_data="$(
        cast abi-encode \
            "f(uint8,uint256,address,address,address,uint256,bytes,uint256)" \
            2 \
            "$CHAIN_A_ID" \
            "$SOURCE_GATEWAY" \
            "$DESTINATION_GATEWAY" \
            "$DESTINATION_RECEIVER" \
            "$expected_nonce" \
            "$PAYLOAD" \
            "$expected_deadline"
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
    local validator_pid
    local validator_attempt
    local validators_alive
    local worker_pid_file

    trap - EXIT INT TERM
    set +e

    for worker_pid_file in "$VALIDATOR_PID_FILE" "$RELAYER_PID_FILE"; do
      if [[ -n "$worker_pid_file" ]] && [[ -f "$worker_pid_file" ]]; then
        while IFS= read -r validator_pid; do
            if [[ "$validator_pid" =~ ^[1-9][0-9]*$ ]]; then
                kill "$validator_pid" 2>/dev/null || true
            fi
        done < "$worker_pid_file"
        for validator_attempt in {1..50}; do
            validators_alive="false"
            while IFS= read -r validator_pid; do
                if [[ "$validator_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$validator_pid" 2>/dev/null; then
                    validators_alive="true"
                fi
            done < "$worker_pid_file"
            [[ "$validators_alive" == "true" ]] || break
            sleep 0.1
        done
        while IFS= read -r validator_pid; do
            if [[ "$validator_pid" =~ ^[1-9][0-9]*$ ]]; then
                kill -KILL "$validator_pid" 2>/dev/null || true
            fi
        done < "$worker_pid_file"
      fi
    done

    if [[ "$STARTED_CHAINS" == "true" ]] && [[ -n "$CHAINS_PID" ]]; then
        printf '\nStopping the local chains started by this verification...\n'
        kill "$CHAINS_PID" 2>/dev/null || true
        wait "$CHAINS_PID" 2>/dev/null || true
    fi

    if [[ -n "$TEMP_DIR" ]] && [[ -d "$TEMP_DIR" ]]; then
        rm -f -- \
            "$TEMP_DIR/deploy-output.log" \
            "$TEMP_DIR/deployment-addresses.env" \
            "$TEMP_DIR/remote-registry-addresses.env" \
            "$TEMP_DIR/validator-registry-addresses.env" \
            "$TEMP_DIR/validator-registry-config.env" \
            "$TEMP_DIR/pbft-verifier-addresses.env" \
            "$TEMP_DIR/merkle-verifier-addresses.env" \
            "$TEMP_DIR/message-domain-verifier-addresses.env" \
            "$TEMP_DIR/alternate-message-domain-verifier-addresses.env" \
            "$TEMP_DIR/replay-test-addresses.env" \
            "$TEMP_DIR/application-b-test-addresses.env" \
            "$TEMP_DIR/destination-gateway-addresses.env" \
            "$TEMP_DIR/validator-pids" \
            "$TEMP_DIR/relayer-pids" \
            "$TEMP_DIR/forwarding-calldata.txt"
        rmdir "$TEMP_DIR" 2>/dev/null || true
    fi

    if [[ "$exit_code" -eq 0 ]]; then
        printf '\n========================================\n'
        printf 'VERIFICATION PASSED\n'
        printf '%s\n' "$VERIFICATION_NAME"
        printf '========================================\n'
    else
        printf '\n========================================\n' >&2
        printf 'VERIFICATION FAILED during: %s (exit code %s)\n' "$CURRENT_STEP" "$exit_code" >&2
        printf '%s\n' "$VERIFICATION_NAME" >&2
        printf '========================================\n' >&2
    fi

    exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '========================================\n'
printf '%s\n' "$VERIFICATION_NAME"
printf 'Cross-Chain Protocol Verification\n'
printf '========================================\n'
printf 'Verification time: %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"
printf 'Project root: %s\n' "$PROJECT_ROOT"
printf 'Contracts directory: %s\n' "$CONTRACTS_DIR"
printf 'Log file: %s\n' "$LOG_FILE"
printf 'Full verification finality profile: successor depth = %s\n' "$FULL_VERIFICATION_FINALITY_BLOCK_DEPTH"
printf 'Effective FINALITY_BLOCK_DEPTH: %q\n' "$FINALITY_BLOCK_DEPTH"

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
printf '  1. Check Node.js, Indexer dependencies, and PostgreSQL connectivity\n'
printf '  2. Apply the Indexer migrations and run unit/database tests\n'
printf '  3. Check or start Chain A and Chain B\n'
printf '  4. Verify chain IDs and select the proof timestamp\n'
printf '  5. Validate the credential model, fixtures, and state encoding\n'
printf '  6. Build and verify the ZK circuit, proofs, and nullifier cases\n'
printf '  7. Generate the Solidity verifier and canonical message fixtures\n'
printf '  8. Build and test the Solidity contracts\n'
printf '  9. Deploy the current Chain A protocol and Chain B remote-gateway trust registry\n'
printf ' 10. Preserve credential policy, replay, epoch, and revocation checks\n'
printf ' 11. Preserve canonical message domain separation and authorization checks\n'
printf '     Require exact source routing/deadline errors and unchanged nonce/nullifier/business state\n'
printf ' 12. Produce and persist a real Chain A message as OBSERVED\n'
printf ' 13. Abruptly stop the Indexer after its durable range commit\n'
printf ' 14. Recreate the PostgreSQL client and recover persisted state\n'
printf ' 15. Recover a message emitted while the Indexer was offline\n'
printf ' 16. Verify repeated Indexer restarts remain idempotent\n'
printf ' 17. Abruptly stop and restart the Finality Watcher from FINALIZING\n'
printf ' 18. Verify exact-depth FINALIZED transitions and unique batch eligibility\n'
printf ' 19. Re-scan a FINALIZED event and preserve lifecycle metadata\n'
printf ' 20. Persist canonical metadata for event-bearing and empty source blocks\n'
printf '     Hold a fixed-head Watcher while an independent Indexer commits canonical H+1/H+N; preserve blocks, messages and cursor\n'
printf '     Bound finality candidates to H and process deferred H+1 on later fixed snapshots\n'
printf '     Reject stale recovery state and preserve genuine fork, terminal REORGED and finalized-fork regression checks\n'
printf ' 21. Replace a real Anvil branch and recover from its common ancestor\n'
printf ' 22. Preserve the old occurrence as terminal REORGED\n'
printf ' 23. Restart indexing from the reorg-rewound cursor and finalize the replacement\n'
printf ' 24. Verify batch encoding, permutations, explicit epochs, and invalid inputs\n'
printf ' 25. Build a deterministic batch from real FINALIZED occurrences only\n'
printf ' 26. Rebuild the same batch with a fresh builder and preserve source lifecycle data\n'
printf ' 27. Verify batch integrity, deterministic Merkle leaves, nodes, roots, and proofs\n'
printf ' 28. Commit the real FINALIZED batch into a deterministic Message Root\n'
printf ' 29. Verify real inclusion proofs and reject tampered message, root, and proof cases\n'
printf ' 30. Rebuild the same root and proofs while preserving source state\n'
printf ' 31. Persist one BUILDING batch per source scope and assign finalized occurrences once\n'
printf ' 32. Atomically seal canonical membership, batch ID, count, and Message Root\n'
printf ' 33. Verify immutable sealed snapshots, rollback, and concurrent retries\n'
printf ' 34. Restore SEALED and CONSENSUS_PENDING snapshots in fresh processes\n'
printf ' 35. Reject COMMITTED transitions without verified COMMIT quorum and QC authorization\n'
printf ' 36. Finalize a later real message into the next epoch and preserve old proofs\n'
printf ' 37. Detect committed Merkle fixture drift without rewriting expected values\n'
printf ' 38. Match off-chain and Solidity domains, leaves, nodes, roots, and proofs to one shared fixture\n'
printf ' 39. Reject shared cross-runtime proof mutations and encoding mismatches\n'
printf ' 40. Verify fresh-process SEALED A/B/D proofs in the Solidity test-local EVM\n'
printf ' 41. Test validator identities, handshake domains, HTTP inputs, and independent source validation\n'
printf ' 42. Apply validator-owned migrations and verify four isolated identity-bound stores\n'
printf ' 43. Start four independent validator processes and authenticate all directed peer pairs\n'
printf ' 44. Complete startup validation before readiness; verify isolated observations, receipts, logs, and fixed-head revalidation\n'
printf ' 45. Reject corrupt real candidates and wrong chain, Gateway, or validator identity\n'
printf ' 46. Restart V4, preserve independent local observations, and leave batches CONSENSUS_PENDING\n'
printf ' 47. Verify canonical committee ordering and exact deterministic primary selection\n'
printf ' 48. Encode, sign, and authenticate domain-separated PRE-PREPARE proposals\n'
printf ' 49. Verify durable epoch/view locks, concurrent delivery, rejection isolation, and migration retries\n'
printf ' 50. Propose the real pending A/B/D batch and independently revalidate it on backups\n'
printf ' 51. Reject wrong primary, signature, epoch, reference, root, lifecycle, and source state\n'
printf ' 52. Recover primary/backup safety locks and retry a controlled partial broadcast\n'
printf ' 53. Preserve all source state after PRE-PREPARE alone, before PREPARE voting\n'
printf ' 54. Encode, sign, recover, and authenticate domain-separated PREPARE votes\n'
printf ' 55. Require a durable accepted PRE-PREPARE before casting each validator vote\n'
printf ' 56. Persist self PREPARE before broadcast and reject durable double-vote conflicts\n'
printf ' 57. Exchange unique PREPARE votes across four independent validator processes\n'
printf ' 58. Keep two matching votes below quorum and form local PREPARED state at three\n'
printf ' 59. Exclude duplicate, wrong-context, and conflicting votes from quorum weight\n'
printf ' 60. Recover PREPARE locks, vote collections, and PREPARED state after restart\n'
printf ' 61. Preserve CONSENSUS_PENDING without COMMIT votes, commit quorum, or QC\n'
printf ' 62. Encode and authenticate COMMIT votes bound to the static committee\n'
printf ' 63. Require durable local PREPARED and persist self COMMIT before broadcast\n'
printf ' 64. Preserve one COMMIT per voter and epoch/view across duplicates, conflicts, and restart\n'
printf ' 65. Require three distinct matching COMMIT voters for durable COMMIT_QUORUM\n'
printf ' 66. Construct and independently verify canonical 3-of-4 and 4-of-4 QCs\n'
printf ' 67. Reject insufficient, duplicate-signer, tampered, and mismatched QCs\n'
printf ' 68. Atomically persist QC evidence and commit the real A/B/D batch\n'
printf ' 69. Roll back an interrupted QC transaction and retry equivalent concurrent certificates\n'
printf ' 70. Preserve the first QC when the fourth vote or another valid subset arrives\n'
printf ' 71. Recover COMMIT locks and verify COMMITTED batch/QC in fresh processes\n'
printf ' 72. Preserve source history, sealed membership, roots, proofs, and next-epoch Message E\n'
printf ' 73. Check deterministic directional transport gates and bidirectional 2|2 partitions\n'
printf ' 74. Verify consistent PREPARE snapshots while third-vote writes wait at explicit lock barriers\n'
printf ' 75. Reindex real A/B/D into independent fully migrated source and validator test namespaces\n'
printf ' 76. Stop a dynamically selected non-primary process and commit with exactly three live signers\n'
printf ' 77. Restart the offline validator and verify the global QC without fabricating its historical votes\n'
printf ' 78. Reject validly signed conflicting-root messages and forged QCs from one Byzantine backup\n'
printf ' 79. Query durable state to require at most one committed root per source scope and epoch\n'
printf ' 80. Keep four processes alive in a 2|2 partition with two voters per side and no quorum or QC\n'
printf ' 81. Heal transport and complete the same proposal by retrying persisted votes without resetting locks\n'
printf ' 82. Stop the deterministic primary and preserve safety before a certified view transition\n'
printf ' 83. Preserve source history, original REORGED C, membership, roots, QC, and Message E across fault scenarios\n'

printf ' 84. Bind PRE-PREPARE, PREPARE, COMMIT, and QC to exact epoch/view context\n'
printf ' 85. Verify signed VIEW_CHANGE and independent three-PREPARE safety certificates\n'
printf ' 86. Require three distinct view-change signers and independently verify NEW_VIEW selection\n'
printf ' 87. Stop real primary processes before/after proposal, partial PREPARE, PREPARED, and partial COMMIT\n'
printf ' 88. Recover timeout intents, current views, NEW_VIEW, and cross-view locks after process restart\n'
printf ' 89. Resume the same safe batch/root through new-view PRE-PREPARE, PREPARE, COMMIT, and QC\n'
printf ' 90. Reject unsafe new-primary roots and old/future-view vote replay\n'
printf ' 91. Advance through views 1 and 2 with an unavailable then stalled primary\n'
printf ' 92. Preserve version-one historical evidence and one committed root across all views\n'
printf ' 93. Rebuild obsolete verification fixtures transactionally and preserve original source tables\n'
printf ' 94. Validate evidence before signing, reject cased duplicates, and preserve canonical digests\n'
printf ' 95. Share bounded durable-view timeout backoff between scheduler and locked database checks\n'
printf ' 96. Refresh recovered view/progress before timeout or voting; preserve signed higher targets\n'
printf ' 97. Require exact delayed NEW_VIEW replay, retained intents and a verified later-view QC after healing\n'
printf ' 98. Verify an existing final QC instead of halting on a concurrent COMMITTED transition\n'
printf ' 99. Check fourth votes before finality and distinguish final QC recognition from active view\n'
printf '100. Keep RPC available through validator shutdown and report recovery state before cleanup\n'
printf '101. Persist append-only validator history and pin batch consensus epochs and committee digests\n'
printf '102. Verify version-three epoch-bound evidence and preserve original version-one/two signatures\n'
printf '103. Reject cross-epoch replay, mixed quorums, removed members, and future members\n'
printf '104. Start five independent validators with two four-member historical committees\n'
printf '105. Commit real A/B/D with epoch 7 and Message E with epoch 8\n'
printf '106. Recover rotated-primary failure without changing the pinned validator epoch\n'
printf '107. Reverify the immutable historical QC after rotation and V1 shutdown\n'
printf '108. Install the durable READY delivery projection with the existing migration entry point\n'
printf '109. Reject non-COMMITTED batches and reverify canonical message, membership, root and historical QC evidence\n'
printf '110. Construct portable per-message packages with sealed positions, proofs and ordered batch message IDs\n'
printf '111. Atomically project complete batches and preserve one immutable READY job per position\n'
printf '112. Reject corrupted message, destination, proof, root, QC and validator-epoch bindings\n'
printf '113. Roll back interrupted delivery inserts and recover after commit without duplicate jobs\n'
printf '114. Run concurrent fresh delivery projectors and strict package readers\n'
printf '115. Queue real A/B/D while excluding REORGED C and preserving source persistence\n'
printf '116. Queue real Message E and retain epoch-7 and epoch-8 historical packages before Relayer submission\n'
printf '117. Validate Single Relayer configuration and keep signer secrets out of public state\n'
printf '118. Strictly re-read and independently verify READY packages immediately before submission\n'
printf '119. ABI-encode versioned deterministic transport envelopes preserving original historical QC evidence\n'
printf '120. Reject corrupt packages, wrong destinations, wrong-chain RPC and invalid returned hashes before recording submissions\n'
printf '121. Submit real A/B/D from the development Relayer A to canonical Chain B gateway targets with zero value\n'
printf '122. Preserve immutable historical direct-submission records without inventing signed transaction fields\n'
printf '123. Match exposed Chain B transaction sender, target, value and exact ABI package bytes\n'
printf '124. Re-run a fresh Relayer A process with no duplicate records or transactions\n'
printf '125. Surface RPC failure and conflicting records while preserving READY/source/consensus evidence\n'
printf '126. Transport real Message E with epoch-8 evidence and preserve historical epoch-7 packages\n'
printf '127. Persist immutable delivery intent bodies and an exact initial type-2 signed attempt\n'
printf '128. Allocate persistent BigInt nonces atomically across independent database clients\n'
printf '129. Estimate gas and resolve EIP-1559 fees from the configured real Chain B RPC\n'
printf '130. Locally sign and persist raw transaction bytes and computed hash before broadcast\n'
printf '131. Independently observe SIGNED database state before forwarding real raw RPC submissions\n'
printf '132. Require the RPC hash to match and retain SIGNED state after broadcast failure\n'
printf '133. Recover exact attempts in fresh processes without re-signing or nonce reuse\n'
printf '134. Block automatic higher-nonce delivery behind an unbroadcast SIGNED transaction\n'
printf '135. Check canonical receipts against one fixed destination head and required confirmation depth\n'
printf '136. Persist immutable CONFIRMED and REVERTED outcomes without retry or business execution claims\n'
printf '137. Reject signed-byte, nonce-state, receipt and package corruption while preserving all source evidence\n'
printf '138. Upgrade existing transaction records in place without changing original signatures or receipts\n'
printf '139. Persist retry counts, classifications and bounded next-action schedules across fresh clients\n'
printf '140. Recover transient or ambiguous sends by broadcasting identical raw bytes and hash\n'
printf '141. Append linear same-nonce attempts with immutable gas, calldata, target and historical evidence\n'
printf '142. Bump both EIP-1559 fees with exact ceiling arithmetic and current market fees\n'
printf '143. Enforce fee caps and maximum attempts without deleting pending delivery state\n'
printf '144. Prevent competing clients from creating two replacements of the same parent\n'
printf '145. Reconcile already-known and nonce-too-low errors against exact local transaction history\n'
printf '146. Accept old or new canonical winners and stop every sibling after confirmation or revert\n'
printf '147. Preserve nonce ordering and fail closed for unknown external nonce consumption\n'
printf '148. Keep a real Chain B transaction pending, recover its replacement in fresh processes and confirm it\n'
printf '149. Restore the original Anvil automine setting after the controlled replacement scenario\n'
printf '150. Configure two independent access paths to the same real Chain B\n'
printf '151. Validate every destination endpoint against expected chain ID and genesis hash\n'
printf '152. Reject duplicate, malformed, wrong-chain and wrong-genesis endpoint configurations\n'
printf '153. Preserve exact persisted raw bytes, hash, fees and nonce across endpoint failover\n'
printf '154. Recover accepted-but-lost primary responses through secondary already-known reconciliation\n'
printf '155. Fail over gas and complete fee reads and conservatively aggregate pending nonces\n'
printf '156. Keep durable nonce allocation ahead of stale provider observations\n'
printf '157. Discover receipts across providers and use a fixed conservative confirmation view\n'
printf '158. Reject same-height block conflicts without finalizing or deleting delivery state\n'
printf '159. Send the exact pending replacement through secondary without another attempt\n'
printf '160. Restore primary preference when its access path recovers\n'
printf '161. Preserve signed history while all destination endpoints are unavailable\n'
printf '162. Start independent Relayer A/B processes with distinct worker IDs and a shared signer\n'
printf '163. Filter READY jobs by source and destination before LIMIT; acquire scoped leases and exact monotonic fencing tokens using database time\n'
printf '164. Verify renewal, release, expiry, restart and duplicate-worker rejection\n'
printf '165. Reject stale ownership and intent mutations within their database transaction\n'
printf '166. Race two OS processes for one job and retain exactly one current owner\n'
printf '167. Stop A before intent creation and allow B takeover only after lease expiry\n'
printf '168. Reject restarted A with its stale token without changing current ownership\n'
printf '169. Stop A after committed SIGNED and let B broadcast the same nonce/raw bytes/hash\n'
printf '170. Distribute separate READY jobs without duplicate intents or nonce spaces\n'
printf '171. Preserve retry/replacement lineage, RPC failover and canonical confirmation\n'
printf '172. Exclude final/stopped intents and preserve immutable queue/source/QC evidence\n'
printf '173. Commit broadcast-start evidence before every external raw transaction send\n'
printf '174. Preserve append-only journal identity, exact sequences and incomplete outcomes\n'
printf '175. Recover from PostgreSQL and canonical Chain B state without worker memory\n'
printf '176. Query historical transaction hashes before any recovery rebroadcast\n'
printf '177. Preserve the atomic intent/nonce/initial-attempt boundary through process loss\n'
printf '178. Stop after SIGNED or broadcast-start commit and resume identical bytes/hash\n'
printf '179. Kill a real worker after Chain B accepts a transaction but before result storage\n'
printf '180. Recover through B with higher fencing without another intent, nonce or signature\n'
printf '181. Interrupt real RPC failover and reconcile through the remaining access path\n'
printf '182. Preserve redacted recovery failure codes/messages/observations and all-path-down transaction state\n'
printf '183. Recover ambiguous replacement history without creating another candidate\n'
printf '     Persist a replacement with its parent genuinely pending; kill the worker before broadcast-start or external send\n'
printf '     Restart B from durable state, check historical canonical receipts first, and send the exact existing replacement despite the pending parent\n'
printf '     Preserve nonce, gas, fees, bytes/hash and linear lineage with no extra estimate, signature or candidate\n'
printf '     Reject stale A recovery fencing and retain the same replacement through RPC failover and accepted-but-lost response recovery\n'
printf '     Reuse the same confirmation snapshot through retry delegation, recovery and lost-response reconciliation\n'
printf '     Keep newly mined evidence non-final in that snapshot; confirm only in a subsequent fresh pass\n'
printf '     Check delegated RECOVERY/REBROADCAST results against the exact persisted attempt, journal, pending RPC body and canonical winner\n'
printf '184. Accept either a historical or replacement canonical winner\n'
printf '     Keep an unbroadcast replacement unsent when its older parent becomes canonical before fresh recovery\n'
printf '185. Reobserve real receipts after a worker dies before persistence\n'
printf '186. Roll back interrupted final writes and atomically persist the same winner\n'
printf '187. Restore final truth after restart without rebroadcasting final intents\n'
printf '188. Serialize concurrent recovery and reject stale post-RPC snapshots\n'
printf '189. Reconcile stopped retries without resetting limits or exhaustion\n'
printf '190. Preserve all source, queue, lease, nonce, signing, retry and RPC invariants\n'
printf '191. Classify structured HTTP/provider errors; verify read/broadcast deadline cancellation and exact-byte fallback\n'
printf '192. Fail over exact persisted bytes after primary HTTP 429 or configured JSON-RPC 429/-32007\n'
printf '193. Recover actual primary acceptance followed by HTTP 408 through a fresh process and secondary hash evidence\n'
printf '194. Retain all-path transient retry schedules across PostgreSQL clients without another nonce or signature\n'
printf '195. Preserve already-known, underpriced, nonce-too-low and deterministic rejection policy without blind fan-out\n'
printf '196. Stop unknown/malformed responses separately; verify migration sequence/reruns and preserve historical upgrade state\n'
printf '197. Keep identity, wrong-hash, fixed-head receipt, pending-parent replacement and secret-redaction regressions intact\n'
printf '198. Match independently frozen forwarding ABI words, full-width digest limbs and eleven-signal mapping across JavaScript/Solidity\n'
printf '199. Require an exact-intent credential proof and executor before atomic Application A forwarding\n'
printf '200. Reject altered routing/payload/deadline, actions, limbs, executor, application/Gateway reuse and proof replay\n'
printf '201. Preserve Gateway nonce/message IDs and failed-call nullifier rollback without a no-proof production path\n'
printf '202. Produce real A/B/C/D/E messages through fresh intent-bound proofs and preserve all existing protocol regressions\n'
printf '203. Deploy RemoteGatewayRegistry to Chain B after confirming chain ID 2001\n'
printf '204. Register the real current Chain A SourceGateway under exact source domain 10011\n'
printf '205. Reject unknown domains, mismatched gateways, zero gateways and unauthorized mutations\n'
printf '206. Replace and remove remote trust deterministically, rejecting the former identity\n'
printf '207. Preserve large uint256 domains and accept remote identities with no Chain B bytecode\n'
printf '208. Restore the current Chain A SourceGateway mapping for subsequent verification\n'
printf '209. Match frozen committee vectors to the existing validator digest and real V1-V5 identities\n'
printf '210. Verify append-only registry history, all 24 permutations and exact uint256 epochs in Solidity\n'
printf '211. Deploy ValidatorSetRegistry to Chain B with the configured trusted operator\n'
printf '212. Register immutable validator epoch 7 (V1-V4) and epoch 8 (V2-V5)\n'
printf '213. Match exact Chain B canonical members, three-of-four quorum and committee digests\n'
printf '214. Reject unknown epochs, zero/duplicate members, unauthorized appends and historical rewrites\n'
printf '215. Reject duplicate, noncontiguous and retroactive validator epochs with specific custom errors\n'
printf '216. Preserve the initial authority anchor and epoch-specific removed/upcoming membership\n'
printf '217. Compare actual five-process rotation history and historical QC bindings to Chain B storage\n'
printf '218. Reject compiler and lint warnings without disabling project-wide lint rules\n'
printf '219. Check independently frozen v1/v2/v3 QC bytes, digests, EIP-191 signatures and relayer transport parity\n'
printf '220. Reject malformed ABI evidence, downgrade/context drift, invalid/extra votes and duplicate recovered signers\n'
printf '221. Deploy the read-only PBFTCertificateVerifier on Chain B with the historical registry\n'
printf '222. Verify frozen quorum/signature/legacy/boundary cases on the actual Chain B verifier\n'
printf '223. Verify existing real epoch 7/8 QCs on-chain, including the old QC after V1 shutdown\n'
printf '224. Reject real-QC root/epoch/signature/quorum/duplicate/nonmember mutations with precise contract errors\n'
printf '225. Verify Solidity viewNumber mapping preserves the original protocol view, uint256 width and context ABI position\n'
printf '226. Retain strict lint with documented local exceptions for bounded fail-fast checks, high-s compatibility and VM fixtures\n'
printf '227. Validate canonical Solidity batch IDs from full nonempty unique ordered membership without a new size cap\n'
printf '228. Verify exact message positions/counts and one shared ordered proof kernel with precise custom errors\n'
printf '229. Preserve uint256 ABI widths and reject wrong context, membership, index, path length and every odd sibling\n'
printf '230. Deploy the stateless MerkleInclusionVerifier on Chain B through the configured operator\n'
printf '231. Verify all 1/2/3/4/5-leaf frozen golden positions, canonical encoding and precise-error negatives on Chain B\n'
printf '232. Authenticate actual old and rotated QC context/root before checking every actual batch member on Chain B\n'
printf '233. Preserve old proofs after rotation/V1 shutdown, single-leaf empty paths and actual odd-duplication checks\n'
printf '234. Reject a QC for a different root even when a standalone Merkle path under that root is valid\n'
printf '235. Match full destination message IDs to the existing SourceGateway, MessageCodec and off-chain encoders\n'
printf '236. Deploy message-domain verifiers with the existing remote registry and explicit destination contexts\n'
printf '237. Accept exactly message version 2 and reject self-consistent unsupported versions\n'
printf '238. Resolve exact source domain/gateway through current remote authority without remote bytecode assumptions\n'
printf '239. Bind destination domain/gateway/receiver, sender, nonce, payload and deadline to the authenticated ID\n'
printf '240. Reject cross-domain and cross-source-gateway substitutions even with internally correct rehashed IDs\n'
printf '241. Preserve strict destination deadline boundaries independently of QC/Merkle validity\n'
printf '242. Verify real epoch-7 A/B/D and epoch-8 Message E full fields under the same authenticated member IDs\n'
printf '243. Reject rehashed receiver/payload/domain variants against the unchanged original root and exclude REORGED C\n'
printf '244. Preserve repeated stateless verification without introducing replay or application execution state\n'
printf '245. Preserve every existing regression; isolate and restore temporary registry/time policy tests after transport workers stop\n'
printf '246. Verify the internal messageId-keyed replay primitive, exact duplicate errors, full bytes32 independence and zero-target harness rejection\n'
printf '247. Deploy TEST-ONLY authenticated replay/callback harnesses without changing the production Relayer target\n'
printf '248. Consume real authenticated A once; reverify unchanged QC/Merkle/message evidence before both same/different-submitter duplicates\n'
printf '249. Keep B unconsumed after invalid QC, Merkle path, domain and downstream failure; accept its authentic retry\n'
printf '250. Verify callback-visible consumed state, exact same-message reentrancy rejection and outer rollback/retry using real D\n'
printf '251. Keep authentic expired E unconsumed while preserving all prior QC/Merkle/domain expiry regressions\n'
printf '252. Preserve consumed IDs through source trust/time changes and restore temporary destination policy state\n'
printf '253. Verify production Application B only-Gateway authority, exact receiver ABI and immutable nonzero Gateway configuration\n'
printf '254. Match Solidity/JS canonical command bytes to independent frozen uint8-version/uint8-action/address vectors\n'
printf '255. Reject direct EOAs, Relayer-like callers, same-code untrusted contracts and tx.origin bypass\n'
printf '256. Reject malformed/dirty/truncated/trailing commands, unsupported versions/actions and zero suppliers\n'
printf '257. Deploy production Application B and two explicitly TEST-ONLY Gateway callers on Chain B\n'
printf '258. Verify exact supplier false-to-true state and correlated business events through the trusted Gateway caller\n'
printf '259. Reject redundant supplier grants independently of message replay; accept an independent second supplier\n'
printf '260. Preserve all prior regressions, historical A/B/D/E payloads, replay authority and the production Relayer target\n'
printf '261. Freeze execute(bytes) with unchanged canonical transport-v1 bytes, package digest and immutable historical transactions\n'
printf '262. Enforce shared 4096-byte payload, 128-member batch and 11232-byte package bounds with cross-language boundary tests\n'
printf '263. Deploy the production DestinationGateway with existing PBFT/Merkle/domain verifiers on Chain B\n'
printf '264. Bind production ApplicationB to that exact Gateway, independently of isolated regression mocks\n'
printf '265. Reject malformed/noncanonical/over-limit packages and nonzero value; preserve precise upstream errors\n'
printf '266. Compose QC, Merkle, full message, replay and contract receiver checks with atomic rollback and reentrancy coverage\n'
printf '267. Authorize fresh supplier commands with unused exact-intent ZK proofs through Application A and SourceGateway\n'
printf '268. Index and finalize new real events through OBSERVED, FINALIZING and FINALIZED without SQL lifecycle shortcuts\n'
printf '269. Build bounded canonical batches and commit their roots through the existing real validator cluster\n'
printf '270. Project real COMMITTED evidence into immutable READY packages\n'
printf '271. Use production Relayer and persistent Tx Manager for exact zero-value Gateway signing, broadcast and confirmation\n'
printf '272. Read back atomic Gateway replay and ApplicationB supplier transitions from Chain B\n'
printf '273. Correlate exact Gateway/business events with the same canonical message and preserve identity separation\n'
printf '274. Recover/rerun normal final-job logic without another intent, nonce, signature or business transition\n'
printf '275. Reverify unchanged crypto/domain evidence and reject exact duplicate delivery from two controlled callers\n'
printf '276. Reject QC/path/domain/receiver/envelope/expiry failures without consuming unexecuted messages\n'
printf '277. Observe a real pre-signed business rejection as terminal REVERTED with Gateway replay rollback\n'
printf '278. Preserve historical A/B/C/D/E, old batches/QCs/transactions and all earlier regressions\n'
printf '279. Keep destination authorization in on-chain Gateway checks and business state in ApplicationB\n'
printf '280. Classify only structured estimate execution reverts as preparation defer; preserve RPC/protocol/fence failures\n'
printf '281. Verify zero intent, nonce allocation, signature, attempt, broadcast and receipt at the preparation rejection boundary\n'
printf '282. Verify migration 016, fenced scheduling, concurrent intent creation, rollback and restart persistence\n'
printf '283. Rotate ordinary and due deferred work across fresh processes, slow one-shots and continuous READY arrivals\n'
printf '284. Observe real ApplicationB estimate rejection before signing, then execute another valid READY message\n'
printf '285. Rotate receipt observation with a durable per-chain/sender full-width nonce cursor\n'
printf '286. Rotate recovery independently without changing send order, allocation or recovery versions\n'
printf '287. Observe a later canonical receipt behind incomplete earlier evidence with limit 1\n'
printf '288. Preserve progress across fresh processes, selection crashes, wrap, terminal removal and concurrent clients\n'
printf '289. Schedule unchanged NO_REPLACEMENT work into the future without signing, sending or nonce allocation\n'

CURRENT_STEP="full verification finality profile validation"
printf '\n[%s]\n' "$CURRENT_STEP"
# Keep this fixed profile in sync with the deterministic integration fixture.
# Production configuration retains its independent exact uint256 validation.
if [[ "$FINALITY_BLOCK_DEPTH" != "$FULL_VERIFICATION_FINALITY_BLOCK_DEPTH" ]]; then
    fail "Unsupported full-verification configuration: FINALITY_BLOCK_DEPTH must be exactly '$FULL_VERIFICATION_FINALITY_BLOCK_DEPTH' (configured value shown in the header). Other valid depths remain supported by production runtime; this deterministic integration fixture does not support them. No database, RPC, proof, build, test or deployment work has started."
fi
printf 'Verified full repository verification profile: FINALITY_BLOCK_DEPTH=%s\n' "$FINALITY_BLOCK_DEPTH"

CURRENT_STEP="Indexer prerequisite verification"
printf '\n[%s]\n' "$CURRENT_STEP"
command -v node >/dev/null 2>&1 || fail "Node.js 22 or later is required for the Chain A Indexer"
NODE_MAJOR_VERSION="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR_VERSION" =~ ^[0-9]+$ ]] || fail "could not determine the Node.js major version"
(( NODE_MAJOR_VERSION >= 22 )) || fail "Node.js 22 or later is required; found $(node --version)"
[[ -n "$DATABASE_URL" ]] \
    || fail "PostgreSQL is required for persistent Chain A indexing. Configure DATABASE_URL in the repository-root .env file."
[[ -f "$INDEXER_DIR/node_modules/viem/package.json" ]] \
    || fail "Indexer dependencies are missing. Run 'cd indexer && npm ci' before verification."
[[ -f "$INDEXER_DIR/node_modules/pg/package.json" ]] \
    || fail "Indexer dependencies are missing. Run 'cd indexer && npm ci' before verification."
[[ -f "$VALIDATOR_DIR/node_modules/viem/package.json" ]] && [[ -f "$VALIDATOR_DIR/node_modules/pg/package.json" ]] \
    || fail "Validator dependencies are missing. Prepare the validator package dependencies before verification; this script does not install them."
printf 'Verified Node.js version: %s\n' "$(node --version)"
printf 'Verified Indexer dependency directories.\n'

CURRENT_STEP="PostgreSQL connectivity verification"
printf '\n[%s]\n' "$CURRENT_STEP"
DATABASE_URL="$DATABASE_URL" \
INDEXER_DB_SCHEMA="$INDEXER_DB_SCHEMA" \
    node "$INDEXER_DIR/src/check-database.mjs"

CURRENT_STEP="Chain A Indexer migrations"
printf '\n[%s]\n' "$CURRENT_STEP"
DATABASE_URL="$DATABASE_URL" \
INDEXER_DB_SCHEMA="$INDEXER_DB_SCHEMA" \
    node "$INDEXER_DIR/src/migrate.mjs"

CURRENT_STEP="committed Merkle golden fixture drift check"
printf '\n[%s]\n' "$CURRENT_STEP"
node "$INDEXER_DIR/scripts/generate-merkle-golden-vectors.mjs" --check

CURRENT_STEP="frozen PBFT certificate reference drift check"
printf '\n[%s]\n' "$CURRENT_STEP"
node "$VALIDATOR_DIR/scripts/generate-pbft-certificate-vectors.mjs" --check

CURRENT_STEP="Chain A Indexer, fixed-snapshot reconciliation, fair receipt/recovery observation, RPC classification, batch, Merkle, golden compatibility, lifecycle, portable delivery, destination-scoped leases and preparation defer/fairness unit tests"
printf '\n[%s]\n' "$CURRENT_STEP"
node --test \
    "$INDEXER_DIR/test/forward-authorization.test.mjs" \
    "$INDEXER_DIR/test/config.test.mjs" \
    "$INDEXER_DIR/test/canonical-message.test.mjs" \
    "$INDEXER_DIR/test/source-event-identity.test.mjs" \
    "$INDEXER_DIR/test/canonical-block.test.mjs" \
    "$INDEXER_DIR/test/reorg-detector.test.mjs" \
    "$INDEXER_DIR/test/finality-policy.test.mjs" \
    "$INDEXER_DIR/test/indexer.test.mjs" \
    "$INDEXER_DIR/test/finality-watcher.test.mjs" \
    "$INDEXER_DIR/test/message-batch.test.mjs" \
    "$INDEXER_DIR/test/message-merkle.test.mjs" \
    "$INDEXER_DIR/test/message-merkle-golden.test.mjs" \
    "$INDEXER_DIR/test/batch-lifecycle-policy.test.mjs" \
    "$INDEXER_DIR/test/delivery-config.test.mjs" \
    "$INDEXER_DIR/test/delivery-package.test.mjs" \
    "$INDEXER_DIR/test/delivery-policy.test.mjs" \
    "$INDEXER_DIR/test/relayer-config.test.mjs" \
    "$INDEXER_DIR/test/relayer-encoding.test.mjs" \
    "$INDEXER_DIR/test/relayer-service.test.mjs" \
    "$INDEXER_DIR/test/transaction-manager.test.mjs" \
    "$INDEXER_DIR/test/transaction-retry.test.mjs" \
    "$INDEXER_DIR/test/rpc-pool.test.mjs" \
    "$INDEXER_DIR/test/relayer-leases.test.mjs" \
    "$INDEXER_DIR/test/transaction-recovery.test.mjs"

CURRENT_STEP="Chain A Indexer database, migration sequence/upgrades, fixed-snapshot concurrency, RPC retry/restart, batch/Merkle/lifecycle, delivery leases, preparation fairness and independent receipt/recovery cursors with fresh-process/crash/concurrency tests"
printf '\n[%s]\n' "$CURRENT_STEP"
DATABASE_URL="$DATABASE_URL" \
INDEXER_DB_SCHEMA="$INDEXER_DATABASE_TEST_SCHEMA" \
    node --test \
        "$INDEXER_DIR/test/database.test.mjs" \
        "$INDEXER_DIR/test/batch-lifecycle.database.test.mjs" \
        "$INDEXER_DIR/test/delivery.database.test.mjs" \
        "$INDEXER_DIR/test/relayer.database.test.mjs" \
        "$INDEXER_DIR/test/transaction-manager.database.test.mjs" \
        "$INDEXER_DIR/test/transaction-retry.database.test.mjs" \
        "$INDEXER_DIR/test/rpc-failover.database.test.mjs" \
        "$INDEXER_DIR/test/relayer-leases.database.test.mjs" \
        "$INDEXER_DIR/test/transaction-recovery.database.test.mjs"

CURRENT_STEP="independent validator, PRE-PREPARE, PREPARE, COMMIT, QC, Solidity ABI context mapping and fault transport unit tests"
printf '\n[%s]\n' "$CURRENT_STEP"
node --test \
    "$VALIDATOR_DIR/test/config.test.mjs" \
    "$VALIDATOR_DIR/test/handshake.test.mjs" \
    "$VALIDATOR_DIR/test/source-validation.test.mjs" \
    "$VALIDATOR_DIR/test/server.test.mjs" \
    "$VALIDATOR_DIR/test/pre-prepare.test.mjs" \
    "$VALIDATOR_DIR/test/prepare.test.mjs" \
    "$VALIDATOR_DIR/test/commit.test.mjs" \
    "$VALIDATOR_DIR/test/fault-transport.test.mjs" \
    "$VALIDATOR_DIR/test/view-change.test.mjs" \
    "$VALIDATOR_DIR/test/validator-sets.test.mjs" \
    "$VALIDATOR_DIR/test/validator-set-golden.test.mjs" \
    "$VALIDATOR_DIR/test/pbft-certificate-golden.test.mjs"

CURRENT_STEP="isolated validator migrations, endpoint/history separation, consistent PREPARE reads, COMMIT locks, and quorum persistence tests"
printf '\n[%s]\n' "$CURRENT_STEP"
DATABASE_URL="${VALIDATOR_VERIFICATION_DATABASE_URL:-$DATABASE_URL}" \
VALIDATOR_DATABASE_TEST_SCHEMA="cross_chain_validator_database_verification" \
    node --test "$VALIDATOR_DIR/test/database.test.mjs"

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

CURRENT_STEP="chain ID and proof timestamp verification"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal "$(cast chain-id --rpc-url "$CHAIN_A_RPC")" "$CHAIN_A_ID" "Chain A ID"
assert_equal "$(cast chain-id --rpc-url "$CHAIN_B_RPC")" "$CHAIN_B_ID" "Chain B ID"

CHAIN_A_LATEST_TIMESTAMP="$(cast block latest --field timestamp --rpc-url "$CHAIN_A_RPC")"
[[ "$CHAIN_A_LATEST_TIMESTAMP" =~ ^[0-9]+$ ]] \
    || fail "Chain A timestamp must be an unsigned integer"
PROOF_TIMESTAMP=$((CHAIN_A_LATEST_TIMESTAMP + PROOF_TIMESTAMP_OFFSET))
printf 'Chain A latest timestamp: %s\n' "$CHAIN_A_LATEST_TIMESTAMP"
printf 'Credential proof timestamp: %s\n' "$PROOF_TIMESTAMP"

DEPLOYER_NONCE="$(cast nonce "$SOURCE_SENDER" --rpc-url "$CHAIN_A_RPC")"
[[ "$DEPLOYER_NONCE" =~ ^[0-9]+$ ]] || fail "Chain A deployer nonce must be an unsigned integer"
IDENTITY_APPLICATION_NONCE=$((DEPLOYER_NONCE + 3))
COMPUTED_ADDRESS_OUTPUT="$(cast compute-address "$SOURCE_SENDER" --nonce "$IDENTITY_APPLICATION_NONCE")"
PREDICTED_IDENTITY_APPLICATION_ADDRESS="$(
    printf '%s\n' "$COMPUTED_ADDRESS_OUTPUT" \
        | sed -nE 's/.*(0x[[:xdigit:]]{40}).*/\1/p' \
        | tail -n 1
)"
[[ "$PREDICTED_IDENTITY_APPLICATION_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "could not predict the IdentityApplicationA deployment address"

APPLICATION_DOMAIN_NAMESPACE_HASH="$(cast keccak "$APPLICATION_DOMAIN_NAMESPACE")"
APPLICATION_DOMAIN_PREIMAGE="$(
    cast abi-encode \
        "f(bytes32,uint256,address)" \
        "$APPLICATION_DOMAIN_NAMESPACE_HASH" \
        "$CHAIN_A_ID" \
        "$PREDICTED_IDENTITY_APPLICATION_ADDRESS"
)"
APPLICATION_DOMAIN_HASH="$(cast keccak "$APPLICATION_DOMAIN_PREIMAGE")"
APPLICATION_DOMAIN="$(
    python3 -c \
        'import sys; print(int(sys.argv[1], 16) % int(sys.argv[2]))' \
        "$APPLICATION_DOMAIN_HASH" \
        "$SNARK_SCALAR_FIELD"
)"
[[ "$APPLICATION_DOMAIN" =~ ^[1-9][0-9]*$ ]] || fail "application domain must be a non-zero field element"

printf 'Predicted IdentityApplicationA address: %s\n' "$PREDICTED_IDENTITY_APPLICATION_ADDRESS"
printf 'Application domain: %s\n' "$APPLICATION_DOMAIN"

CURRENT_STEP="credential model validation"
printf '\n[%s]\n' "$CURRENT_STEP"
cd "$PROJECT_ROOT"
python3 "$PROJECT_ROOT/zk/credential-model/validate.py"

CURRENT_STEP="ZK circuit verification and Solidity verifier export"
printf '\n[%s]\n' "$CURRENT_STEP"
CREDENTIAL_PROOF_TIMESTAMP="$PROOF_TIMESTAMP" \
APPLICATION_DOMAIN="$APPLICATION_DOMAIN" \
    bash "$PROJECT_ROOT/zk/scripts/verify-circuit.sh"

CURRENT_STEP="canonical message vector generation"
printf '\n[%s]\n' "$CURRENT_STEP"
node "$PROJECT_ROOT/scripts/build-canonical-message-vector.mjs"
node "$INDEXER_DIR/scripts/build-forward-authorization-vectors.mjs"

cd "$CONTRACTS_DIR"

CURRENT_STEP="generated Solidity source formatting"
printf '\n[%s]\n' "$CURRENT_STEP"
forge fmt \
    generated/Groth16Verifier.sol \
    generated/CredentialProofFixture.sol \
    generated/ForwardCredentialProofFixture.sol \
    generated/ForwardAuthorizationVector.sol \
    generated/CanonicalMessageVector.sol

CURRENT_STEP="forge build"
printf '\n[%s]\n' "$CURRENT_STEP"
forge build --deny warnings --no-lint

CURRENT_STEP="Solidity lint warning verification"
printf '\n[%s]\n' "$CURRENT_STEP"
# Run lint once with warning failures enabled; compilation above keeps its own warning guard.
# Protocol/test-specific exceptions are documented at their source sites; global rules remain enabled.
forge lint --deny warnings

CURRENT_STEP="forge test -vv including shared Merkle golden compatibility"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test -vv

printf 'VALID: malformed Gateway offsets and impossible batch-array lengths reject with exact empty revert / Panic(0x41); replay, business state and events remain unchanged\n'
printf 'VALID: Solidity PBFT certificates match frozen v1/v2/v3 digests, trusted context and signature acceptance\n'
printf 'VALID: bounded ABI evidence, historical/legacy authority and every quorum entry verified\n'
printf 'VALID: Solidity canonical batch IDs, exact membership/count/position and ordered inclusion checks verified\n'
printf 'VALID: precise-error proof failures include single-leaf paths, full-width indexes and every odd level\n'
printf 'VALID: message-domain unit cases cover source authority, explicit targets, exact identity and strict expiry\n'
printf 'VALID: existing canonical vectors, empty payloads, unsupported versions and stateless repeated checks preserved\n'
printf 'VALID: Solidity replay cases cover distinct callers/IDs, full-width keys, zero-target rejection, no reset, callback ordering and rollback/retry\n'
printf 'VALID: Solidity Application B cases cover exact Gateway authority, strict canonical commands, business errors/state/events and frozen vectors\n'
printf 'VALID: Solidity ValidatorSetRegistry matches shared frozen committee vectors and canonical ordering\n'
printf 'VALID: all 24 committee permutations, immutable history and fixed three-of-four quorum verified\n'
printf 'VALID: exact zero, large and maximum uint256 validator epochs are independent of batch epochs\n'
printf 'VALID: Solidity Merkle domains, leaves, and internal nodes match shared golden vectors\n'
printf 'VALID: off-chain and Solidity roots and proofs match the same shared golden vectors\n'
printf 'VALID: cross-runtime negative cases and trusted leaf-count checks verified\n'

CURRENT_STEP="canonical gateway encoding test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testGatewayUsesCanonicalMessageIdEncoding -vvv

CURRENT_STEP="identity field separation test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testEveryIdentityFieldChangesMessageId -vvv

CURRENT_STEP="shared golden vector test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testSharedGoldenVectorsMatchCanonicalEncoding -vvv
printf 'VALID: canonical message domain vectors matched\n'

CURRENT_STEP="source domain separation test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testSourceDomainChangesMessageId -vvv
printf 'VALID: different source domain changed message ID\n'

CURRENT_STEP="destination domain separation test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testDestinationDomainChangesMessageId -vvv
printf 'VALID: different destination domain changed message ID\n'

CURRENT_STEP="source gateway separation test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testSameNonceAcrossSourceGatewaysProducesDifferentMessageIds -vvv
printf 'VALID: different source gateway changed message ID\n'

CURRENT_STEP="destination gateway separation test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testDestinationGatewayChangesMessageId -vvv
printf 'VALID: different destination gateway changed message ID\n'

CURRENT_STEP="event consistency test"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-test testEmitsCrossChainMessage -vvv

CURRENT_STEP="credential verifier tests"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-contract CredentialVerifierTest -vvv

CURRENT_STEP="identity application tests"
printf '\n[%s]\n' "$CURRENT_STEP"
forge test --match-contract IdentityApplicationATest -vvv

CURRENT_STEP="on-chain ZK nullifier and revocation lifecycle"
printf '\n[%s]\n' "$CURRENT_STEP"
TEMP_PARENT="${TMPDIR:-/tmp}"
TEMP_DIR="$(mktemp -d "$TEMP_PARENT/cross-chain-verification.XXXXXX")"
DEPLOYMENT_ADDRESSES_FILE="$TEMP_DIR/deployment-addresses.env"
REMOTE_REGISTRY_ADDRESSES_FILE="$TEMP_DIR/remote-registry-addresses.env"
VALIDATOR_REGISTRY_ADDRESSES_FILE="$TEMP_DIR/validator-registry-addresses.env"
VALIDATOR_REGISTRY_CONFIG_FILE="$TEMP_DIR/validator-registry-config.env"
PBFT_VERIFIER_ADDRESSES_FILE="$TEMP_DIR/pbft-verifier-addresses.env"
MERKLE_VERIFIER_ADDRESSES_FILE="$TEMP_DIR/merkle-verifier-addresses.env"
MESSAGE_DOMAIN_ADDRESSES_FILE="$TEMP_DIR/message-domain-verifier-addresses.env"
ALTERNATE_MESSAGE_DOMAIN_ADDRESSES_FILE="$TEMP_DIR/alternate-message-domain-verifier-addresses.env"
REPLAY_TEST_ADDRESSES_FILE="$TEMP_DIR/replay-test-addresses.env"
APPLICATION_B_TEST_ADDRESSES_FILE="$TEMP_DIR/application-b-test-addresses.env"
DESTINATION_GATEWAY_ADDRESSES_FILE="$TEMP_DIR/destination-gateway-addresses.env"
VALIDATOR_PID_FILE="$TEMP_DIR/validator-pids"
RELAYER_PID_FILE="$TEMP_DIR/relayer-pids"
: > "$VALIDATOR_PID_FILE"
: > "$RELAYER_PID_FILE"
CHAIN_A_RPC_URL="$CHAIN_A_RPC" \
CHAIN_A_EXPECTED_ID="$CHAIN_A_ID" \
VERIFIER_DEPLOYER_KEY="$ANVIL_DEV_KEY" \
APPLICATION_MAX_PROOF_AGE="$APPLICATION_MAX_PROOF_AGE" \
CREDENTIAL_STATE_AUTHORITY="$SOURCE_SENDER" \
SOURCE_AUTHORIZATION_ADMIN="$SOURCE_SENDER" \
EXPECTED_IDENTITY_APPLICATION_ADDRESS="$PREDICTED_IDENTITY_APPLICATION_ADDRESS" \
DEPLOYMENT_OUTPUT_FILE="$DEPLOYMENT_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-verifier.sh"

[[ -f "$DEPLOYMENT_ADDRESSES_FILE" ]] || fail "deployment address output is missing"
SOURCE_GATEWAY="$(sed -nE 's/^SOURCE_GATEWAY_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$DEPLOYMENT_ADDRESSES_FILE")"
IDENTITY_APPLICATION_ADDRESS="$(
    sed -nE 's/^IDENTITY_APPLICATION_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$DEPLOYMENT_ADDRESSES_FILE"
)"
[[ "$SOURCE_GATEWAY" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid deployed SourceGateway address"
[[ "$IDENTITY_APPLICATION_ADDRESS" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "invalid deployed IdentityApplicationA address"
assert_hex_equal \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$PREDICTED_IDENTITY_APPLICATION_ADDRESS" \
    "predicted IdentityApplicationA address"

CURRENT_STEP="SourceGateway deployment reuse"
printf '\n[%s]\n' "$CURRENT_STEP"
printf 'SourceGateway: %s\n' "$SOURCE_GATEWAY"
printf 'IdentityApplicationA: %s\n' "$IDENTITY_APPLICATION_ADDRESS"

CURRENT_STEP="Chain B RemoteGatewayRegistry deployment and trust-boundary verification"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
CHAIN_B_EXPECTED_ID="$CHAIN_B_ID" \
REGISTRY_DEPLOYER_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
REGISTRY_ADMIN="$CHAIN_B_REGISTRY_ADMIN" \
REMOTE_SOURCE_DOMAIN="$CHAIN_A_ID" \
REMOTE_SOURCE_GATEWAY="$SOURCE_GATEWAY" \
DEPLOYMENT_OUTPUT_FILE="$REMOTE_REGISTRY_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-remote-gateway-registry.sh"

[[ -f "$REMOTE_REGISTRY_ADDRESSES_FILE" ]] \
    || fail "RemoteGatewayRegistry deployment address output is missing"
REMOTE_GATEWAY_REGISTRY="$(
    sed -nE 's/^REMOTE_GATEWAY_REGISTRY_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' \
        "$REMOTE_REGISTRY_ADDRESSES_FILE"
)"
[[ "$REMOTE_GATEWAY_REGISTRY" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "invalid deployed RemoteGatewayRegistry address"

assert_hex_equal \
    "$(cast call "$REMOTE_GATEWAY_REGISTRY" \
        "registryAdmin()(address)" \
        --rpc-url "$CHAIN_B_RPC")" \
    "$CHAIN_B_REGISTRY_ADMIN" \
    "Chain B registry administrator"
assert_hex_equal \
    "$(cast call "$REMOTE_GATEWAY_REGISTRY" \
        "trustedRemoteGateway(uint256)(address)" \
        "$CHAIN_A_ID" \
        --rpc-url "$CHAIN_B_RPC")" \
    "$SOURCE_GATEWAY" \
    "trusted Chain A SourceGateway identity"
assert_equal \
    "$(cast call "$REMOTE_GATEWAY_REGISTRY" \
        "isTrustedRemoteGateway(uint256,address)(bool)" \
        "$CHAIN_A_ID" \
        "$SOURCE_GATEWAY" \
        --rpc-url "$CHAIN_B_RPC")" \
    "true" \
    "exact remote domain and Gateway pair"
cast call "$REMOTE_GATEWAY_REGISTRY" \
    "requireTrustedRemoteGateway(uint256,address)" \
    "$CHAIN_A_ID" \
    "$SOURCE_GATEWAY" \
    --rpc-url "$CHAIN_B_RPC" >/dev/null
printf 'Trusted remote source: domain = %s, gateway = %s\n' "$CHAIN_A_ID" "$SOURCE_GATEWAY"

assert_hex_equal \
    "$(cast call "$REMOTE_GATEWAY_REGISTRY" \
        "trustedRemoteGateway(uint256)(address)" \
        "$UNKNOWN_REMOTE_DOMAIN" \
        --rpc-url "$CHAIN_B_RPC")" \
    "$ZERO_ADDRESS" \
    "unknown remote domain zero result"
expect_call_revert \
    "unknown remote domain rejected" \
    "UnknownSourceDomain(uint256)" \
    "$REMOTE_GATEWAY_REGISTRY" \
    "requireTrustedRemoteGateway(uint256,address)" \
    "$UNKNOWN_REMOTE_DOMAIN" \
    "$SOURCE_GATEWAY" \
    --rpc-url "$CHAIN_B_RPC"
expect_call_revert \
    "mismatched remote gateway rejected" \
    "UntrustedRemoteGateway(uint256,address,address)" \
    "$REMOTE_GATEWAY_REGISTRY" \
    "requireTrustedRemoteGateway(uint256,address)" \
    "$CHAIN_A_ID" \
    "$REMOTE_ROTATION_GATEWAY" \
    --rpc-url "$CHAIN_B_RPC"
expect_call_revert \
    "zero remote gateway rejected" \
    "InvalidRemoteGateway()" \
    "$REMOTE_GATEWAY_REGISTRY" \
    "setRemoteGateway(uint256,address)" \
    "$UNKNOWN_REMOTE_DOMAIN" \
    "$ZERO_ADDRESS" \
    --from "$CHAIN_B_REGISTRY_ADMIN" \
    --rpc-url "$CHAIN_B_RPC"
expect_call_revert \
    "unauthorized remote gateway add rejected" \
    "UnauthorizedRegistryAdmin()" \
    "$REMOTE_GATEWAY_REGISTRY" \
    "setRemoteGateway(uint256,address)" \
    "$UNKNOWN_REMOTE_DOMAIN" \
    "$REMOTE_ROTATION_GATEWAY" \
    --from "$UNAUTHORIZED_CALLER" \
    --rpc-url "$CHAIN_B_RPC"
expect_call_revert \
    "unauthorized remote gateway replacement rejected" \
    "UnauthorizedRegistryAdmin()" \
    "$REMOTE_GATEWAY_REGISTRY" \
    "setRemoteGateway(uint256,address)" \
    "$CHAIN_A_ID" \
    "$REMOTE_ROTATION_GATEWAY" \
    --from "$UNAUTHORIZED_CALLER" \
    --rpc-url "$CHAIN_B_RPC"
expect_call_revert \
    "unauthorized remote gateway removal rejected" \
    "UnauthorizedRegistryAdmin()" \
    "$REMOTE_GATEWAY_REGISTRY" \
    "removeRemoteGateway(uint256)" \
    "$CHAIN_A_ID" \
    --from "$UNAUTHORIZED_CALLER" \
    --rpc-url "$CHAIN_B_RPC"
printf 'Unauthorized registry add, replacement and removal rejected.\n'

REMOTE_TEST_CODE="$(cast code "$REMOTE_NO_CODE_GATEWAY" --rpc-url "$CHAIN_B_RPC")"
[[ -z "$REMOTE_TEST_CODE" ]] || [[ "$REMOTE_TEST_CODE" == "0x" ]] \
    || fail "remote no-code fixture unexpectedly contains Chain B bytecode"
send_registry_transaction \
    "setRemoteGateway(uint256,address)" \
    "$LARGE_REMOTE_DOMAIN" \
    "$REMOTE_NO_CODE_GATEWAY"
assert_transaction_success "$LAST_TX_HASH" "large-domain no-code remote registration" "$CHAIN_B_RPC"
assert_hex_equal \
    "$(cast call "$REMOTE_GATEWAY_REGISTRY" \
        "trustedRemoteGateway(uint256)(address)" \
        "$LARGE_REMOTE_DOMAIN" \
        --rpc-url "$CHAIN_B_RPC")" \
    "$REMOTE_NO_CODE_GATEWAY" \
    "large uint256 remote domain"
printf 'Remote address with no local Chain B bytecode accepted as remote identity.\n'
send_registry_transaction "removeRemoteGateway(uint256)" "$LARGE_REMOTE_DOMAIN"
assert_transaction_success "$LAST_TX_HASH" "large-domain remote removal" "$CHAIN_B_RPC"

send_registry_transaction \
    "setRemoteGateway(uint256,address)" \
    "$CHAIN_A_ID" \
    "$REMOTE_ROTATION_GATEWAY"
assert_transaction_success "$LAST_TX_HASH" "remote gateway replacement" "$CHAIN_B_RPC"
assert_equal \
    "$(cast call "$REMOTE_GATEWAY_REGISTRY" \
        "isTrustedRemoteGateway(uint256,address)(bool)" \
        "$CHAIN_A_ID" \
        "$SOURCE_GATEWAY" \
        --rpc-url "$CHAIN_B_RPC")" \
    "false" \
    "former remote gateway after replacement"
send_registry_transaction "removeRemoteGateway(uint256)" "$CHAIN_A_ID"
assert_transaction_success "$LAST_TX_HASH" "remote gateway removal" "$CHAIN_B_RPC"
expect_call_revert \
    "removed remote domain rejected" \
    "UnknownSourceDomain(uint256)" \
    "$REMOTE_GATEWAY_REGISTRY" \
    "requireTrustedRemoteGateway(uint256,address)" \
    "$CHAIN_A_ID" \
    "$REMOTE_ROTATION_GATEWAY" \
    --rpc-url "$CHAIN_B_RPC"
send_registry_transaction \
    "setRemoteGateway(uint256,address)" \
    "$CHAIN_A_ID" \
    "$SOURCE_GATEWAY"
assert_transaction_success "$LAST_TX_HASH" "canonical remote gateway restoration" "$CHAIN_B_RPC"
assert_hex_equal \
    "$(cast call "$REMOTE_GATEWAY_REGISTRY" \
        "trustedRemoteGateway(uint256)(address)" \
        "$CHAIN_A_ID" \
        --rpc-url "$CHAIN_B_RPC")" \
    "$SOURCE_GATEWAY" \
    "restored canonical Chain A SourceGateway"
printf 'Restored trusted remote source: domain = %s, gateway = %s\n' "$CHAIN_A_ID" "$SOURCE_GATEWAY"

CURRENT_STEP="trusted validator history and frozen digest export"
printf '\n[%s]\n' "$CURRENT_STEP"
node "$PROJECT_ROOT/scripts/build-validator-set-vector.mjs" > "$VALIDATOR_REGISTRY_CONFIG_FILE"
# Only validated public addresses, decimal epochs and committee digests are exported here.
# shellcheck disable=SC1090
source "$VALIDATOR_REGISTRY_CONFIG_FILE"

CURRENT_STEP="Chain B ValidatorSetRegistry deployment and historical authority verification"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
REGISTRY_DEPLOYER_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
REGISTRY_ADMIN="$CHAIN_B_REGISTRY_ADMIN" \
VALIDATOR_INITIAL_EPOCH="$VALIDATOR_INITIAL_EPOCH" \
VALIDATOR_ROTATED_EPOCH="$VALIDATOR_ROTATED_EPOCH" \
VALIDATOR_INITIAL_MEMBERS="$VALIDATOR_INITIAL_MEMBERS" \
VALIDATOR_ROTATED_MEMBERS="$VALIDATOR_ROTATED_MEMBERS" \
VALIDATOR_INITIAL_DIGEST="$VALIDATOR_INITIAL_DIGEST" \
VALIDATOR_ROTATED_DIGEST="$VALIDATOR_ROTATED_DIGEST" \
DEPLOYMENT_OUTPUT_FILE="$VALIDATOR_REGISTRY_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-validator-set-registry.sh"
[[ -f "$VALIDATOR_REGISTRY_ADDRESSES_FILE" ]] \
    || fail "ValidatorSetRegistry deployment address output is missing"
VALIDATOR_SET_REGISTRY="$(sed -nE \
    's/^VALIDATOR_SET_REGISTRY_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' \
    "$VALIDATOR_REGISTRY_ADDRESSES_FILE")"
[[ "$VALIDATOR_SET_REGISTRY" =~ ^0x[[:xdigit:]]{40}$ ]] \
    || fail "invalid deployed ValidatorSetRegistry address"
assert_hex_equal \
    "$(cast call "$VALIDATOR_SET_REGISTRY" "registryAdmin()(address)" --rpc-url "$CHAIN_B_RPC")" \
    "$CHAIN_B_REGISTRY_ADMIN" "historical validator registry administrator"
assert_equal \
    "$(cast call "$VALIDATOR_SET_REGISTRY" "initialValidatorEpoch()(uint256)" --rpc-url "$CHAIN_B_RPC" | awk '{print $1}')" \
    "$VALIDATOR_INITIAL_EPOCH" "immutable initial validator epoch"
assert_equal \
    "$(cast call "$VALIDATOR_SET_REGISTRY" "latestValidatorEpoch()(uint256)" --rpc-url "$CHAIN_B_RPC" | awk '{print $1}')" \
    "$VALIDATOR_ROTATED_EPOCH" "latest appended validator epoch"

CURRENT_STEP="exact historical validator membership"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal "$(cast call "$VALIDATOR_SET_REGISTRY" "isValidator(uint256,address)(bool)" \
    "$VALIDATOR_INITIAL_EPOCH" "$VALIDATOR_IDENTITY_V1" --rpc-url "$CHAIN_B_RPC")" true "V1 historical epoch 7 membership"
assert_equal "$(cast call "$VALIDATOR_SET_REGISTRY" "isValidator(uint256,address)(bool)" \
    "$VALIDATOR_ROTATED_EPOCH" "$VALIDATOR_IDENTITY_V1" --rpc-url "$CHAIN_B_RPC")" false "V1 exclusion from epoch 8"
assert_equal "$(cast call "$VALIDATOR_SET_REGISTRY" "isValidator(uint256,address)(bool)" \
    "$VALIDATOR_INITIAL_EPOCH" "$VALIDATOR_IDENTITY_V5" --rpc-url "$CHAIN_B_RPC")" false "V5 exclusion from historical epoch 7"
assert_equal "$(cast call "$VALIDATOR_SET_REGISTRY" "isValidator(uint256,address)(bool)" \
    "$VALIDATOR_ROTATED_EPOCH" "$VALIDATOR_IDENTITY_V5" --rpc-url "$CHAIN_B_RPC")" true "V5 rotated epoch 8 membership"

CURRENT_STEP="historical validator authority negative cases"
printf '\n[%s]\n' "$CURRENT_STEP"
INITIAL_VALIDATOR_RECORD="$(cast call "$VALIDATOR_SET_REGISTRY" "getValidatorSet(uint256)" \
    "$VALIDATOR_INITIAL_EPOCH" --rpc-url "$CHAIN_B_RPC")"
ROTATED_VALIDATOR_RECORD="$(cast call "$VALIDATOR_SET_REGISTRY" "getValidatorSet(uint256)" \
    "$VALIDATOR_ROTATED_EPOCH" --rpc-url "$CHAIN_B_RPC")"
for UNKNOWN_VALIDATOR_EPOCH in 0 6 9; do
    assert_equal "$(cast call "$VALIDATOR_SET_REGISTRY" "hasValidatorSet(uint256)(bool)" \
        "$UNKNOWN_VALIDATOR_EPOCH" --rpc-url "$CHAIN_B_RPC")" false "unknown epoch has no registry record"
    expect_call_revert "unknown validator epoch $UNKNOWN_VALIDATOR_EPOCH rejected" "UnknownValidatorEpoch(uint256)" \
        "$VALIDATOR_SET_REGISTRY" "getValidatorSet(uint256)" "$UNKNOWN_VALIDATOR_EPOCH" --rpc-url "$CHAIN_B_RPC"
done
expect_call_revert "zero validator rejected" "ZeroValidator()" \
    "$VALIDATOR_SET_REGISTRY" "registerValidatorSet(uint256,address[4])" 9 \
    "[$ZERO_ADDRESS,$VALIDATOR_IDENTITY_V2,$VALIDATOR_IDENTITY_V3,$VALIDATOR_IDENTITY_V4]" \
    --from "$CHAIN_B_REGISTRY_ADMIN" --rpc-url "$CHAIN_B_RPC"
expect_call_revert "duplicate validator identity rejected" "DuplicateValidator(address)" \
    "$VALIDATOR_SET_REGISTRY" "registerValidatorSet(uint256,address[4])" 9 \
    "[$VALIDATOR_IDENTITY_V1,$VALIDATOR_IDENTITY_V2,$VALIDATOR_IDENTITY_V2,$VALIDATOR_IDENTITY_V4]" \
    --from "$CHAIN_B_REGISTRY_ADMIN" --rpc-url "$CHAIN_B_RPC"
expect_call_revert "duplicate historical epoch rejected" "ValidatorEpochAlreadyRegistered(uint256)" \
    "$VALIDATOR_SET_REGISTRY" "registerValidatorSet(uint256,address[4])" \
    "$VALIDATOR_INITIAL_EPOCH" "$VALIDATOR_INITIAL_MEMBERS" \
    --from "$CHAIN_B_REGISTRY_ADMIN" --rpc-url "$CHAIN_B_RPC"
expect_call_revert "historical validator-set rewrite rejected" "ValidatorEpochAlreadyRegistered(uint256)" \
    "$VALIDATOR_SET_REGISTRY" "registerValidatorSet(uint256,address[4])" \
    "$VALIDATOR_INITIAL_EPOCH" "$VALIDATOR_ROTATED_MEMBERS" \
    --from "$CHAIN_B_REGISTRY_ADMIN" --rpc-url "$CHAIN_B_RPC"
expect_call_revert "noncontiguous validator epoch rejected" "NoncontiguousValidatorEpoch(uint256,uint256)" \
    "$VALIDATOR_SET_REGISTRY" "registerValidatorSet(uint256,address[4])" 10 "$VALIDATOR_ROTATED_MEMBERS" \
    --from "$CHAIN_B_REGISTRY_ADMIN" --rpc-url "$CHAIN_B_RPC"
expect_call_revert "retroactive validator epoch rejected" "NoncontiguousValidatorEpoch(uint256,uint256)" \
    "$VALIDATOR_SET_REGISTRY" "registerValidatorSet(uint256,address[4])" 6 "$VALIDATOR_INITIAL_MEMBERS" \
    --from "$CHAIN_B_REGISTRY_ADMIN" --rpc-url "$CHAIN_B_RPC"
expect_call_revert "unauthorized validator-set registration rejected" "UnauthorizedRegistryAdmin()" \
    "$VALIDATOR_SET_REGISTRY" "registerValidatorSet(uint256,address[4])" 9 "$VALIDATOR_ROTATED_MEMBERS" \
    --from "$UNAUTHORIZED_CALLER" --rpc-url "$CHAIN_B_RPC"
assert_hex_equal "$(cast call "$VALIDATOR_SET_REGISTRY" "getValidatorSet(uint256)" \
    "$VALIDATOR_INITIAL_EPOCH" --rpc-url "$CHAIN_B_RPC")" "$INITIAL_VALIDATOR_RECORD" "preserved historical epoch 7 after rejected mutations"
assert_hex_equal "$(cast call "$VALIDATOR_SET_REGISTRY" "getValidatorSet(uint256)" \
    "$VALIDATOR_ROTATED_EPOCH" --rpc-url "$CHAIN_B_RPC")" "$ROTATED_VALIDATOR_RECORD" "preserved historical epoch 8 after rejected mutations"
assert_equal "$(cast call "$VALIDATOR_SET_REGISTRY" "hasValidatorSet(uint256)(bool)" \
    9 --rpc-url "$CHAIN_B_RPC")" false "failed appends leave epoch 9 unregistered"

CURRENT_STEP="Chain B historical PBFT certificate verifier deployment"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
VERIFIER_DEPLOYER_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
VALIDATOR_SET_REGISTRY_ADDRESS="$VALIDATOR_SET_REGISTRY" \
DEPLOYMENT_OUTPUT_FILE="$PBFT_VERIFIER_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-pbft-certificate-verifier.sh"
[[ -f "$PBFT_VERIFIER_ADDRESSES_FILE" ]] || fail "PBFT verifier deployment output is missing"
PBFT_CERTIFICATE_VERIFIER="$(sed -nE \
    's/^PBFT_CERTIFICATE_VERIFIER_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' \
    "$PBFT_VERIFIER_ADDRESSES_FILE")"
[[ "$PBFT_CERTIFICATE_VERIFIER" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid deployed PBFT verifier address"

CURRENT_STEP="Chain B frozen PBFT certificate acceptance and exact-error rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
PBFT_CERTIFICATE_VERIFIER_ADDRESS="$PBFT_CERTIFICATE_VERIFIER" \
VALIDATOR_SET_REGISTRY_ADDRESS="$VALIDATOR_SET_REGISTRY" \
    node "$VALIDATOR_DIR/scripts/verify-pbft-certificates.mjs"

CURRENT_STEP="Chain B canonical Merkle inclusion verifier deployment"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
VERIFIER_DEPLOYER_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
DEPLOYMENT_OUTPUT_FILE="$MERKLE_VERIFIER_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-merkle-inclusion-verifier.sh"
[[ -f "$MERKLE_VERIFIER_ADDRESSES_FILE" ]] || fail "Merkle verifier deployment output is missing"
MERKLE_INCLUSION_VERIFIER="$(sed -nE \
    's/^MERKLE_INCLUSION_VERIFIER_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' \
    "$MERKLE_VERIFIER_ADDRESSES_FILE")"
[[ "$MERKLE_INCLUSION_VERIFIER" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid deployed Merkle inclusion verifier address"

CURRENT_STEP="Chain B frozen Merkle encoding, membership and exact-error rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
MERKLE_INCLUSION_VERIFIER_ADDRESS="$MERKLE_INCLUSION_VERIFIER" \
    node "$INDEXER_DIR/scripts/verify-merkle-inclusion.mjs"

CURRENT_STEP="Chain B message-domain verifier deployment"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
VERIFIER_DEPLOYER_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
REMOTE_GATEWAY_REGISTRY_ADDRESS="$REMOTE_GATEWAY_REGISTRY" \
LOCAL_DESTINATION_DOMAIN="$CHAIN_B_ID" \
DEPLOYMENT_OUTPUT_FILE="$MESSAGE_DOMAIN_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-message-domain-verifier.sh"
[[ -f "$MESSAGE_DOMAIN_ADDRESSES_FILE" ]] || fail "message-domain verifier deployment output is missing"
MESSAGE_DOMAIN_VERIFIER="$(sed -nE \
    's/^MESSAGE_DOMAIN_VERIFIER_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$MESSAGE_DOMAIN_ADDRESSES_FILE")"
[[ "$MESSAGE_DOMAIN_VERIFIER" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid message-domain verifier address"

CURRENT_STEP="alternate configured protocol-domain verifier for cross-domain rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
# This stateless comparison target runs on the existing Chain B network; no third chain is started.
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
VERIFIER_DEPLOYER_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
REMOTE_GATEWAY_REGISTRY_ADDRESS="$REMOTE_GATEWAY_REGISTRY" \
LOCAL_DESTINATION_DOMAIN="$ALTERNATE_DESTINATION_DOMAIN" \
DEPLOYMENT_OUTPUT_FILE="$ALTERNATE_MESSAGE_DOMAIN_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-message-domain-verifier.sh"
[[ -f "$ALTERNATE_MESSAGE_DOMAIN_ADDRESSES_FILE" ]] || fail "alternate-domain verifier deployment output is missing"
ALTERNATE_MESSAGE_DOMAIN_VERIFIER="$(sed -nE \
    's/^MESSAGE_DOMAIN_VERIFIER_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$ALTERNATE_MESSAGE_DOMAIN_ADDRESSES_FILE")"
[[ "$ALTERNATE_MESSAGE_DOMAIN_VERIFIER" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid alternate-domain verifier address"

CURRENT_STEP="Chain B existing canonical full-message encoding parity"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
REMOTE_GATEWAY_REGISTRY_ADDRESS="$REMOTE_GATEWAY_REGISTRY" \
MESSAGE_DOMAIN_VERIFIER_ADDRESS="$MESSAGE_DOMAIN_VERIFIER" \
LOCAL_DESTINATION_DOMAIN="$CHAIN_B_ID" \
    node "$INDEXER_DIR/scripts/verify-message-domain.mjs"

CURRENT_STEP="Chain B TEST-ONLY authenticated replay harness and atomicity receiver deployment"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
VERIFIER_DEPLOYER_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
PBFT_CERTIFICATE_VERIFIER_ADDRESS="$PBFT_CERTIFICATE_VERIFIER" \
MERKLE_INCLUSION_VERIFIER_ADDRESS="$MERKLE_INCLUSION_VERIFIER" \
MESSAGE_DOMAIN_VERIFIER_ADDRESS="$MESSAGE_DOMAIN_VERIFIER" \
EXPECTED_DESTINATION_GATEWAY="$DESTINATION_GATEWAY" \
DEPLOYMENT_OUTPUT_FILE="$REPLAY_TEST_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-replay-test-harness.sh"
[[ -f "$REPLAY_TEST_ADDRESSES_FILE" ]] || fail "test replay deployment output is missing"
REPLAY_TEST_HARNESS="$(sed -nE 's/^REPLAY_TEST_HARNESS_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$REPLAY_TEST_ADDRESSES_FILE")"
REPLAY_TEST_RECEIVER="$(sed -nE 's/^REPLAY_TEST_RECEIVER_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$REPLAY_TEST_ADDRESSES_FILE")"
[[ "$REPLAY_TEST_HARNESS" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid test replay harness address"
[[ "$REPLAY_TEST_RECEIVER" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid test replay receiver address"

CURRENT_STEP="deployment code verification"
printf '\n[%s]\n' "$CURRENT_STEP"
DEPLOYED_CODE="$(cast code "$SOURCE_GATEWAY" --rpc-url "$CHAIN_A_RPC")"

if [[ -z "$DEPLOYED_CODE" ]] || [[ "$DEPLOYED_CODE" == "0x" ]]; then
    fail "SourceGateway address has no deployed bytecode"
fi

printf 'Verified deployed bytecode at %s.\n' "$SOURCE_GATEWAY"

MESSAGE_CHAIN_TIMESTAMP="$(cast block latest --field timestamp --rpc-url "$CHAIN_A_RPC")"
[[ "$MESSAGE_CHAIN_TIMESTAMP" =~ ^[0-9]+$ ]] || fail "Chain A timestamp must be an unsigned integer"
MESSAGE_DEADLINE=$((MESSAGE_CHAIN_TIMESTAMP + 3600))
FIRST_MESSAGE_DEADLINE="$MESSAGE_DEADLINE"
printf 'Source message deadline: %s\n' "$MESSAGE_DEADLINE"

CURRENT_STEP="initial contract state verification"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "MESSAGE_VERSION()(uint8)" --rpc-url "$CHAIN_A_RPC")" \
    "2" \
    "message version"
assert_hex_equal \
    "$(cast call "$SOURCE_GATEWAY" "MESSAGE_TYPEHASH()(bytes32)" --rpc-url "$CHAIN_A_RPC")" \
    "$(cast keccak "$MESSAGE_TYPE")" \
    "message type hash"
assert_hex_equal \
    "$(cast call "$SOURCE_GATEWAY" "authorizationAdmin()(address)" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_SENDER" \
    "source authorization admin"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" \
        "authorizedSourceApplications(address)(bool)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        --rpc-url "$CHAIN_A_RPC")" \
    "true" \
    "IdentityApplicationA source authorization"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "1" \
    "initial nonce"
printf 'VALID: IdentityApplicationA registered as source application\n'

CURRENT_STEP="unknown source application deployment"
printf '\n[%s]\n' "$CURRENT_STEP"
deploy_unknown_source_application
printf 'Unknown source application: %s\n' "$UNKNOWN_SOURCE_APPLICATION"

CURRENT_STEP="payload verification"
printf '\n[%s]\n' "$CURRENT_STEP"
PAYLOAD_TEXT="$(cast to-utf8 "$PAYLOAD")"
assert_equal "$PAYLOAD_TEXT" "$EXPECTED_PAYLOAD_TEXT" "payload UTF-8 text"

PAYLOAD_HASH="$(cast keccak "$PAYLOAD")"
assert_hex_equal "$PAYLOAD_HASH" "$EXPECTED_PAYLOAD_HASH" "payload hash"

CURRENT_STEP="non-admin source authorization rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
expect_call_revert \
    "non-admin source authorization update rejected" \
    "UnauthorizedAuthorizationAdmin()" \
    "$SOURCE_GATEWAY" \
    "setSourceApplicationAuthorization(address,bool)" \
    "$UNKNOWN_SOURCE_APPLICATION" \
    true \
    --from "$UNAUTHORIZED_CALLER" \
    --rpc-url "$CHAIN_A_RPC"

CURRENT_STEP="zero source application rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
expect_call_revert \
    "zero source application authorization rejected" \
    "InvalidSourceApplication()" \
    "$SOURCE_GATEWAY" \
    "setSourceApplicationAuthorization(address,bool)" \
    "$ZERO_ADDRESS" \
    true \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"

CURRENT_STEP="unknown direct EOA rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
expect_call_revert \
    "unknown EOA rejected" \
    "UnauthorizedSourceApplication()" \
    "$SOURCE_GATEWAY" \
    "sendMessage(uint256,address,address,bytes,uint256)(bytes32,uint256)" \
    "$CHAIN_B_ID" \
    "$DESTINATION_GATEWAY" \
    "$DESTINATION_RECEIVER" \
    "$PAYLOAD" \
    "$MESSAGE_DEADLINE" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"

CURRENT_STEP="unknown source application rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
expect_call_revert \
    "unknown application rejected" \
    "UnauthorizedSourceApplication()" \
    "$UNKNOWN_SOURCE_APPLICATION" \
    "sendCrossChainMessage(address,uint256,address,address,bytes,uint256)(bytes32,uint256)" \
    "$SOURCE_GATEWAY" \
    "$CHAIN_B_ID" \
    "$DESTINATION_GATEWAY" \
    "$DESTINATION_RECEIVER" \
    "$PAYLOAD" \
    "$MESSAGE_DEADLINE" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "1" \
    "nonce after unauthorized source rejection"
printf 'VALID: unauthorized sends did not consume nonce\n'

CURRENT_STEP="first message ID prediction"
prepare_application_forwarding
printf '\n[%s]\n' "$CURRENT_STEP"
FIRST_EXPECTED_MESSAGE_ID="$(
    cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        "$CHAIN_B_ID" \
        "$DESTINATION_GATEWAY" \
        "$DESTINATION_RECEIVER" \
        1 \
        "$PAYLOAD_HASH" \
        "$MESSAGE_DEADLINE" \
        --rpc-url "$CHAIN_A_RPC"
)"
printf 'First expected message ID: %s\n' "$FIRST_EXPECTED_MESSAGE_ID"

CURRENT_STEP="destination domain separation verification"
printf '\n[%s]\n' "$CURRENT_STEP"
ALTERNATE_DOMAIN_MESSAGE_ID="$(
    cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        "$ALTERNATE_DESTINATION_DOMAIN" \
        "$DESTINATION_GATEWAY" \
        "$DESTINATION_RECEIVER" \
        1 \
        "$PAYLOAD_HASH" \
        "$MESSAGE_DEADLINE" \
        --rpc-url "$CHAIN_A_RPC"
)"
if [[ "$(normalize "$FIRST_EXPECTED_MESSAGE_ID")" == "$(normalize "$ALTERNATE_DOMAIN_MESSAGE_ID")" ]]; then
    fail "different destination domains produced identical message IDs"
fi
printf 'VALID: different destination domain changed message ID\n'

CURRENT_STEP="destination gateway separation verification"
printf '\n[%s]\n' "$CURRENT_STEP"
ALTERNATE_GATEWAY_MESSAGE_ID="$(
    cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        "$CHAIN_B_ID" \
        "$ALTERNATE_DESTINATION_GATEWAY" \
        "$DESTINATION_RECEIVER" \
        1 \
        "$PAYLOAD_HASH" \
        "$MESSAGE_DEADLINE" \
        --rpc-url "$CHAIN_A_RPC"
)"
if [[ "$(normalize "$FIRST_EXPECTED_MESSAGE_ID")" == "$(normalize "$ALTERNATE_GATEWAY_MESSAGE_ID")" ]]; then
    fail "different destination gateways produced identical message IDs"
fi
printf 'VALID: destination gateway bound to message ID\n'

CURRENT_STEP="first message send"
printf '\n[%s]\n' "$CURRENT_STEP"
send_application_message
FIRST_TX_HASH="$LAST_TX_HASH"

CURRENT_STEP="first message event verification"
verify_message_event \
    "$FIRST_TX_HASH" \
    "$FIRST_EXPECTED_MESSAGE_ID" \
    1 \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$MESSAGE_DEADLINE" \
    "first message"

CURRENT_STEP="nonce verification after first message"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "2" \
    "nonce after first message"

MESSAGE_DEADLINE=$((MESSAGE_DEADLINE + 1))
prepare_application_forwarding
CURRENT_STEP="second message ID prediction"
printf '\n[%s]\n' "$CURRENT_STEP"
SECOND_EXPECTED_MESSAGE_ID="$(
    cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        "$CHAIN_B_ID" \
        "$DESTINATION_GATEWAY" \
        "$DESTINATION_RECEIVER" \
        2 \
        "$PAYLOAD_HASH" \
        "$MESSAGE_DEADLINE" \
        --rpc-url "$CHAIN_A_RPC"
)"
printf 'Second expected message ID: %s\n' "$SECOND_EXPECTED_MESSAGE_ID"

if [[ "$(normalize "$FIRST_EXPECTED_MESSAGE_ID")" == "$(normalize "$SECOND_EXPECTED_MESSAGE_ID")" ]]; then
    fail "different nonces produced identical message IDs"
fi

NONCE_ONLY_MESSAGE_ID="$(
    cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$IDENTITY_APPLICATION_ADDRESS" "$CHAIN_B_ID" "$DESTINATION_GATEWAY" "$DESTINATION_RECEIVER" \
        2 "$PAYLOAD_HASH" "$FIRST_MESSAGE_DEADLINE" --rpc-url "$CHAIN_A_RPC"
)"
if [[ "$(normalize "$FIRST_EXPECTED_MESSAGE_ID")" == "$(normalize "$NONCE_ONLY_MESSAGE_ID")" ]]; then
    fail "changing only the Gateway nonce did not change the canonical message ID"
fi
printf 'Verified canonical nonce-only domain separation and distinct authorized request IDs.\n'

CURRENT_STEP="second message send"
printf '\n[%s]\n' "$CURRENT_STEP"
send_application_message
SECOND_TX_HASH="$LAST_TX_HASH"

CURRENT_STEP="second message event verification"
verify_message_event \
    "$SECOND_TX_HASH" \
    "$SECOND_EXPECTED_MESSAGE_ID" \
    2 \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$MESSAGE_DEADLINE" \
    "second message"

CURRENT_STEP="nonce verification after second message"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "3" \
    "nonce after second message"

MESSAGE_DEADLINE=$((MESSAGE_DEADLINE + 1))
prepare_application_forwarding
CURRENT_STEP="Application A message ID prediction"
printf '\n[%s]\n' "$CURRENT_STEP"
APPLICATION_EXPECTED_MESSAGE_ID="$(
    cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        "$CHAIN_B_ID" \
        "$DESTINATION_GATEWAY" \
        "$DESTINATION_RECEIVER" \
        3 \
        "$PAYLOAD_HASH" \
        "$MESSAGE_DEADLINE" \
        --rpc-url "$CHAIN_A_RPC"
)"
printf 'Application A expected message ID: %s\n' "$APPLICATION_EXPECTED_MESSAGE_ID"

CURRENT_STEP="Application A to SourceGateway message send"
printf '\n[%s]\n' "$CURRENT_STEP"
send_application_message
APPLICATION_MESSAGE_TX_HASH="$LAST_TX_HASH"

CURRENT_STEP="Application A CrossChainMessage verification"
verify_message_event \
    "$APPLICATION_MESSAGE_TX_HASH" \
    "$APPLICATION_EXPECTED_MESSAGE_ID" \
    3 \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$MESSAGE_DEADLINE" \
    "Application A message"
printf 'VALID: Application A called SourceGateway\n'
printf 'VALID: Application A forwarded destination gateway\n'
printf 'VALID: CrossChainMessage sourceSender equals IdentityApplicationA\n'
printf 'VALID: deadline is bound to the recomputed message ID\n'

CURRENT_STEP="nonce verification after Application A message"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "4" \
    "nonce after Application A message"

CURRENT_STEP="source policy revert-helper fixtures and before-state snapshot"
printf '\n[%s]\n' "$CURRENT_STEP"
verify_call_revert_assertions
# Reuse the exact proof just accepted above, including its already-used nullifier.
# These eth_call simulations cannot persist a transaction or CrossChainMessage log.
SOURCE_NEGATIVE_COMMITMENT="$(sed -n '4p' "$TEMP_DIR/forwarding-calldata.txt")"
SOURCE_NEGATIVE_NULLIFIER="$(sed -n '12p' "$TEMP_DIR/forwarding-calldata.txt")"
[[ "$SOURCE_NEGATIVE_COMMITMENT" =~ ^[0-9]+$ ]] || fail "invalid forwarding credential commitment"
[[ "$SOURCE_NEGATIVE_NULLIFIER" =~ ^[0-9]+$ ]] || fail "invalid forwarding nullifier"
SOURCE_NEGATIVE_NONCE_BEFORE="$(cast call "$SOURCE_GATEWAY" 'nextNonce()(uint256)' --rpc-url "$CHAIN_A_RPC")"
SOURCE_NEGATIVE_NULLIFIER_BEFORE="$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'usedNullifiers(uint256)(bool)' "$SOURCE_NEGATIVE_NULLIFIER" --rpc-url "$CHAIN_A_RPC")"
SOURCE_NEGATIVE_STATUS_BEFORE="$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'authorizationStatus(uint256)(uint8)' "$SOURCE_NEGATIVE_COMMITMENT" --rpc-url "$CHAIN_A_RPC")"

CURRENT_STEP="expired Application A message rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
EXPIRED_MESSAGE_DEADLINE="$(cast block latest --field timestamp --rpc-url "$CHAIN_A_RPC")"
expect_call_revert \
    "expired deadline rejected" "InvalidDeadline()" \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$FORWARD_SIGNATURE" \
    "$FORWARD_PROOF_A" "$FORWARD_PROOF_B" "$FORWARD_PROOF_C" "$FORWARD_PUBLIC_INPUTS" \
    "($CHAIN_B_ID,$DESTINATION_GATEWAY,$DESTINATION_RECEIVER,$PAYLOAD,$EXPIRED_MESSAGE_DEADLINE)" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_NONCE_BEFORE" \
    "nonce unchanged after expired deadline rejection"
assert_equal \
    "$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'usedNullifiers(uint256)(bool)' "$SOURCE_NEGATIVE_NULLIFIER" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_NULLIFIER_BEFORE" \
    "nullifier state unchanged after expired deadline rejection"
assert_equal \
    "$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'authorizationStatus(uint256)(uint8)' "$SOURCE_NEGATIVE_COMMITMENT" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_STATUS_BEFORE" \
    "business state unchanged after expired deadline rejection"

CURRENT_STEP="zero destination gateway rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
expect_call_revert \
    "zero destination gateway rejected" "InvalidDestinationGateway()" \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$FORWARD_SIGNATURE" \
    "$FORWARD_PROOF_A" "$FORWARD_PROOF_B" "$FORWARD_PROOF_C" "$FORWARD_PUBLIC_INPUTS" \
    "($CHAIN_B_ID,$ZERO_ADDRESS,$DESTINATION_RECEIVER,$PAYLOAD,$MESSAGE_DEADLINE)" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_NONCE_BEFORE" \
    "nonce unchanged after zero destination gateway rejection"
assert_equal \
    "$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'usedNullifiers(uint256)(bool)' "$SOURCE_NEGATIVE_NULLIFIER" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_NULLIFIER_BEFORE" \
    "nullifier state unchanged after zero destination gateway rejection"
assert_equal \
    "$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'authorizationStatus(uint256)(uint8)' "$SOURCE_NEGATIVE_COMMITMENT" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_STATUS_BEFORE" \
    "business state unchanged after zero destination gateway rejection"

CURRENT_STEP="same-chain destination rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
expect_call_revert \
    "local destination domain rejected" "InvalidDestinationDomain()" \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$FORWARD_SIGNATURE" \
    "$FORWARD_PROOF_A" "$FORWARD_PROOF_B" "$FORWARD_PROOF_C" "$FORWARD_PUBLIC_INPUTS" \
    "($CHAIN_A_ID,$DESTINATION_GATEWAY,$DESTINATION_RECEIVER,$PAYLOAD,$MESSAGE_DEADLINE)" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" 'nextNonce()(uint256)' --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_NONCE_BEFORE" \
    "nonce unchanged after local destination domain rejection"
assert_equal \
    "$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'usedNullifiers(uint256)(bool)' "$SOURCE_NEGATIVE_NULLIFIER" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_NULLIFIER_BEFORE" \
    "nullifier state unchanged after local destination domain rejection"
assert_equal \
    "$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'authorizationStatus(uint256)(uint8)' "$SOURCE_NEGATIVE_COMMITMENT" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_STATUS_BEFORE" \
    "business state unchanged after local destination domain rejection"

CURRENT_STEP="zero destination receiver rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
expect_call_revert \
    "zero destination receiver rejected" "InvalidDestinationReceiver()" \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$FORWARD_SIGNATURE" \
    "$FORWARD_PROOF_A" "$FORWARD_PROOF_B" "$FORWARD_PROOF_C" "$FORWARD_PUBLIC_INPUTS" \
    "($CHAIN_B_ID,$DESTINATION_GATEWAY,$ZERO_ADDRESS,$PAYLOAD,$MESSAGE_DEADLINE)" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" 'nextNonce()(uint256)' --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_NONCE_BEFORE" \
    "nonce unchanged after zero destination receiver rejection"
assert_equal \
    "$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'usedNullifiers(uint256)(bool)' "$SOURCE_NEGATIVE_NULLIFIER" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_NULLIFIER_BEFORE" \
    "nullifier state unchanged after zero destination receiver rejection"
assert_equal \
    "$(cast call "$IDENTITY_APPLICATION_ADDRESS" 'authorizationStatus(uint256)(uint8)' "$SOURCE_NEGATIVE_COMMITMENT" --rpc-url "$CHAIN_A_RPC")" \
    "$SOURCE_NEGATIVE_STATUS_BEFORE" \
    "business state unchanged after zero destination receiver rejection"

MESSAGE_DEADLINE=$((MESSAGE_DEADLINE + 1))
prepare_application_forwarding
CURRENT_STEP="IdentityApplicationA source authorization revocation"
printf '\n[%s]\n' "$CURRENT_STEP"
send_source_application_authorization "$IDENTITY_APPLICATION_ADDRESS" false
assert_transaction_success "$LAST_TX_HASH" "IdentityApplicationA source authorization revocation"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" \
        "authorizedSourceApplications(address)(bool)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        --rpc-url "$CHAIN_A_RPC")" \
    "false" \
    "revoked IdentityApplicationA source authorization"

CURRENT_STEP="historical message identity verification after revocation"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_hex_equal \
    "$(cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        "$CHAIN_B_ID" \
        "$DESTINATION_GATEWAY" \
        "$DESTINATION_RECEIVER" \
        1 \
        "$PAYLOAD_HASH" \
        "$FIRST_MESSAGE_DEADLINE" \
        --rpc-url "$CHAIN_A_RPC")" \
    "$FIRST_EXPECTED_MESSAGE_ID" \
    "historical message ID after source application revocation"

CURRENT_STEP="revoked IdentityApplicationA message rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
expect_call_revert \
    "revoked Application A rejected" \
    "UnauthorizedSourceApplication()" \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$FORWARD_SIGNATURE" \
    "$FORWARD_PROOF_A" "$FORWARD_PROOF_B" "$FORWARD_PROOF_C" "$FORWARD_PUBLIC_INPUTS" \
    "($CHAIN_B_ID,$DESTINATION_GATEWAY,$DESTINATION_RECEIVER,$PAYLOAD,$MESSAGE_DEADLINE)" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "4" \
    "nonce after revoked source application rejection"
printf 'VALID: revoked send did not consume nonce\n'

CURRENT_STEP="IdentityApplicationA source reauthorization"
printf '\n[%s]\n' "$CURRENT_STEP"
send_source_application_authorization "$IDENTITY_APPLICATION_ADDRESS" true
assert_transaction_success "$LAST_TX_HASH" "IdentityApplicationA source reauthorization"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" \
        "authorizedSourceApplications(address)(bool)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        --rpc-url "$CHAIN_A_RPC")" \
    "true" \
    "reauthorized IdentityApplicationA source authorization"

REAUTHORIZED_EXPECTED_MESSAGE_ID="$(
    cast call "$SOURCE_GATEWAY" \
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$IDENTITY_APPLICATION_ADDRESS" \
        "$CHAIN_B_ID" \
        "$DESTINATION_GATEWAY" \
        "$DESTINATION_RECEIVER" \
        4 \
        "$PAYLOAD_HASH" \
        "$MESSAGE_DEADLINE" \
        --rpc-url "$CHAIN_A_RPC"
)"
send_application_message
REAUTHORIZED_MESSAGE_TX_HASH="$LAST_TX_HASH"
verify_message_event \
    "$REAUTHORIZED_MESSAGE_TX_HASH" \
    "$REAUTHORIZED_EXPECTED_MESSAGE_ID" \
    4 \
    "$IDENTITY_APPLICATION_ADDRESS" \
    "$MESSAGE_DEADLINE" \
    "reauthorized Application A message"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "5" \
    "nonce after reauthorized Application A message"
printf 'VALID: reauthorized Application A message accepted\n'

CURRENT_STEP="production DestinationGateway and ApplicationB deployment"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
VERIFIER_DEPLOYER_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
PBFT_CERTIFICATE_VERIFIER_ADDRESS="$PBFT_CERTIFICATE_VERIFIER" \
MERKLE_INCLUSION_VERIFIER_ADDRESS="$MERKLE_INCLUSION_VERIFIER" \
MESSAGE_DOMAIN_VERIFIER_ADDRESS="$MESSAGE_DOMAIN_VERIFIER" \
DEPLOYMENT_OUTPUT_FILE="$DESTINATION_GATEWAY_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-destination-gateway.sh"
[[ -f "$DESTINATION_GATEWAY_ADDRESSES_FILE" ]] || fail "production Gateway deployment output is missing"
PRODUCTION_DESTINATION_GATEWAY="$(sed -nE 's/^DESTINATION_GATEWAY_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$DESTINATION_GATEWAY_ADDRESSES_FILE")"
PRODUCTION_APPLICATION_B="$(sed -nE 's/^PRODUCTION_APPLICATION_B_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$DESTINATION_GATEWAY_ADDRESSES_FILE")"
[[ "$PRODUCTION_DESTINATION_GATEWAY" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid production Gateway address"
[[ "$PRODUCTION_APPLICATION_B" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid production Application B address"

CURRENT_STEP="persistent Chain A Indexer integration preparation"
printf '\n[%s]\n' "$CURRENT_STEP"
INDEXER_START_BLOCK="$(cast block latest --field number --rpc-url "$CHAIN_A_RPC")"
[[ "$INDEXER_START_BLOCK" =~ ^[0-9]+$ ]] || fail "latest Chain A block number must be an unsigned integer"
INDEXER_START_BLOCK=$((INDEXER_START_BLOCK + 1))
printf 'Indexer integration start block: %s\n' "$INDEXER_START_BLOCK"

CURRENT_STEP="real source/consensus/transport recovery, historical QC/Merkle/message verification and destination replay/rollback integration"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_A_RPC_URL="$CHAIN_A_RPC" \
CHAIN_A_DOMAIN="$CHAIN_A_ID" \
SOURCE_GATEWAY_ADDRESS="$SOURCE_GATEWAY" \
SOURCE_GATEWAY_START_BLOCK="$INDEXER_START_BLOCK" \
DATABASE_URL="$DATABASE_URL" \
INDEXER_BLOCK_RANGE="$INDEXER_BLOCK_RANGE" \
INDEXER_POLL_INTERVAL_MS="$INDEXER_POLL_INTERVAL_MS" \
FINALITY_BLOCK_DEPTH="$FINALITY_BLOCK_DEPTH" \
FINALITY_POLL_INTERVAL_MS="$FINALITY_POLL_INTERVAL_MS" \
INDEXER_DB_SCHEMA="$INDEXER_DB_SCHEMA" \
IDENTITY_APPLICATION_ADDRESS="$IDENTITY_APPLICATION_ADDRESS" \
INDEXER_INTEGRATION_PRIVATE_KEY="$ANVIL_DEV_KEY" \
INDEXER_INTEGRATION_DESTINATION_DOMAIN="$CHAIN_B_ID" \
INDEXER_INTEGRATION_DESTINATION_GATEWAY="$DESTINATION_GATEWAY" \
INDEXER_INTEGRATION_DESTINATION_RECEIVER="$DESTINATION_RECEIVER" \
VALIDATOR_VERIFICATION_PID_FILE="$VALIDATOR_PID_FILE" \
RELAYER_VERIFICATION_PID_FILE="$RELAYER_PID_FILE" \
VALIDATOR_SET_REGISTRY_ADDRESS="$VALIDATOR_SET_REGISTRY" \
PBFT_CERTIFICATE_VERIFIER_ADDRESS="$PBFT_CERTIFICATE_VERIFIER" \
MERKLE_INCLUSION_VERIFIER_ADDRESS="$MERKLE_INCLUSION_VERIFIER" \
MESSAGE_DOMAIN_VERIFIER_ADDRESS="$MESSAGE_DOMAIN_VERIFIER" \
ALTERNATE_MESSAGE_DOMAIN_VERIFIER_ADDRESS="$ALTERNATE_MESSAGE_DOMAIN_VERIFIER" \
REPLAY_TEST_HARNESS_ADDRESS="$REPLAY_TEST_HARNESS" \
REPLAY_TEST_RECEIVER_ADDRESS="$REPLAY_TEST_RECEIVER" \
REMOTE_GATEWAY_REGISTRY_ADDRESS="$REMOTE_GATEWAY_REGISTRY" \
REMOTE_REGISTRY_ADMIN_PRIVATE_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
INDEXER_INTEGRATION_ALTERNATE_DESTINATION_DOMAIN="$ALTERNATE_DESTINATION_DOMAIN" \
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
CHAIN_B_CHAIN_ID="$CHAIN_B_ID" \
PRODUCTION_DESTINATION_GATEWAY_ADDRESS="$PRODUCTION_DESTINATION_GATEWAY" \
PRODUCTION_APPLICATION_B_ADDRESS="$PRODUCTION_APPLICATION_B" \
RPC_REQUEST_TIMEOUT_MS="$RPC_REQUEST_TIMEOUT_MS" \
RELAYER_A_PRIVATE_KEY="$ANVIL_DEV_KEY" \
RELAYER_WORKER_ID="relayer-a" \
RELAYER_LEASE_MS="$RELAYER_LEASE_MS" \
RELAYER_MAX_JOBS_PER_RUN="100" \
DESTINATION_CONFIRMATIONS="$DESTINATION_CONFIRMATIONS" \
TX_REBROADCAST_INTERVAL_MS="$TX_REBROADCAST_INTERVAL_MS" \
TX_REPLACEMENT_AFTER_MS="$TX_REPLACEMENT_AFTER_MS" \
TX_FEE_BUMP_NUMERATOR="$TX_FEE_BUMP_NUMERATOR" \
TX_FEE_BUMP_DENOMINATOR="$TX_FEE_BUMP_DENOMINATOR" \
TX_MAX_ATTEMPTS="$TX_MAX_ATTEMPTS" \
TX_MAX_FEE_PER_GAS="$TX_MAX_FEE_PER_GAS" \
TX_MAX_PRIORITY_FEE_PER_GAS="$TX_MAX_PRIORITY_FEE_PER_GAS" \
    node --test "$INDEXER_DIR/test/integration.test.mjs"

CURRENT_STEP="production Application B deployment for isolated Gateway-caller verification"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
VERIFIER_DEPLOYER_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
DEPLOYMENT_OUTPUT_FILE="$APPLICATION_B_TEST_ADDRESSES_FILE" \
    bash "$PROJECT_ROOT/scripts/deploy-application-b-test-fixture.sh"
[[ -f "$APPLICATION_B_TEST_ADDRESSES_FILE" ]] || fail "Application B fixture deployment output is missing"
APPLICATION_B="$(sed -nE 's/^APPLICATION_B_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$APPLICATION_B_TEST_ADDRESSES_FILE")"
APPLICATION_B_GATEWAY_TEST="$(sed -nE 's/^APPLICATION_B_GATEWAY_TEST_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$APPLICATION_B_TEST_ADDRESSES_FILE")"
APPLICATION_B_OTHER_GATEWAY_TEST="$(sed -nE 's/^APPLICATION_B_OTHER_GATEWAY_TEST_ADDRESS=(0x[[:xdigit:]]{40})$/\1/p' "$APPLICATION_B_TEST_ADDRESSES_FILE")"
[[ "$APPLICATION_B" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid Application B address"
[[ "$APPLICATION_B_GATEWAY_TEST" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid trusted Gateway fixture address"
[[ "$APPLICATION_B_OTHER_GATEWAY_TEST" =~ ^0x[[:xdigit:]]{40}$ ]] || fail "invalid untrusted Gateway fixture address"

CURRENT_STEP="Application B canonical commands, exact Gateway authority and on-chain supplier business state"
printf '\n[%s]\n' "$CURRENT_STEP"
CHAIN_B_RPC_URL="$CHAIN_B_RPC" \
APPLICATION_B_ADDRESS="$APPLICATION_B" \
APPLICATION_B_GATEWAY_TEST_ADDRESS="$APPLICATION_B_GATEWAY_TEST" \
APPLICATION_B_OTHER_GATEWAY_TEST_ADDRESS="$APPLICATION_B_OTHER_GATEWAY_TEST" \
APPLICATION_B_OPERATOR_KEY="$CHAIN_B_REGISTRY_ADMIN_KEY" \
    node "$INDEXER_DIR/scripts/verify-application-b.mjs"

CURRENT_STEP="complete"
