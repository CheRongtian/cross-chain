#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACTS_DIR="$PROJECT_ROOT/contracts"
LOG_FILE="$PROJECT_ROOT/verification.log"
VERIFICATION_NAME="Domain-separated Chain A Source Messaging"

CHAIN_A_RPC="http://127.0.0.1:4545"
CHAIN_B_RPC="http://127.0.0.1:9545"
CHAIN_A_ID="10011"
CHAIN_B_ID="2001"
ALTERNATE_DESTINATION_DOMAIN="3001"
PROOF_TIMESTAMP_OFFSET="3600"
APPLICATION_MAX_PROOF_AGE="3600"
SNARK_SCALAR_FIELD="21888242871839275222246405745257275088548364400416034343698204186575808495617"
APPLICATION_DOMAIN_NAMESPACE="cross-chain:identity-application-domain:v1"

ANVIL_DEV_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
SOURCE_SENDER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
DESTINATION_GATEWAY="0x000000000000000000000000000000000000d00d"
ALTERNATE_DESTINATION_GATEWAY="0x000000000000000000000000000000000000d00e"
DESTINATION_RECEIVER="0x000000000000000000000000000000000000bEEF"
ZERO_ADDRESS="0x0000000000000000000000000000000000000000"
PAYLOAD="0x68656c6c6f20636861696e2062"
EXPECTED_PAYLOAD_TEXT="hello chain b"
EXPECTED_PAYLOAD_HASH="0x758a9838e83061770f5b75d8544bc7a27cc795a8741c6b50bdf738ee276d23a6"
MESSAGE_TYPE="CrossChainMessage(uint8 version,uint256 sourceDomain,address sourceGateway,address sourceSender,uint256 destinationDomain,address destinationGateway,address destinationReceiver,uint256 nonce,bytes32 payloadHash,uint256 deadline)"
EVENT_SIGNATURE="CrossChainMessage(bytes32,uint8,uint256,address,address,uint256,address,address,uint256,bytes,uint256)"

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
            "sendMessage(uint256,address,address,bytes,uint256)" \
            "$CHAIN_B_ID" \
            "$DESTINATION_GATEWAY" \
            "$DESTINATION_RECEIVER" \
            "$PAYLOAD" \
            "$MESSAGE_DEADLINE" \
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

send_application_message() {
    local output

    output="$(
        cast send "$IDENTITY_APPLICATION_ADDRESS" \
            "sendCrossChainMessage(uint256,address,address,bytes,uint256)" \
            "$CHAIN_B_ID" \
            "$DESTINATION_GATEWAY" \
            "$DESTINATION_RECEIVER" \
            "$PAYLOAD" \
            "$MESSAGE_DEADLINE" \
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

    trap - EXIT INT TERM
    set +e

    if [[ "$STARTED_CHAINS" == "true" ]] && [[ -n "$CHAINS_PID" ]]; then
        printf '\nStopping the local chains started by this verification...\n'
        kill "$CHAINS_PID" 2>/dev/null || true
        wait "$CHAINS_PID" 2>/dev/null || true
    fi

    if [[ -n "$TEMP_DIR" ]] && [[ -d "$TEMP_DIR" ]]; then
        rm -f -- \
            "$TEMP_DIR/deploy-output.log" \
            "$TEMP_DIR/deployment-addresses.env"
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
printf '  1. Check or start Chain A and Chain B\n'
printf '  2. Verify chain IDs and select the proof timestamp\n'
printf '  3. Validate the credential model, fixtures, and state encoding\n'
printf '  4. Build deterministic active-credential roots and Merkle witnesses\n'
printf '  5. Build deterministic nullifier vectors and context-separated inputs\n'
printf '  6. Compile the ZK circuit and verify membership, policy, and nullifier cases\n'
printf '  7. Export the Solidity verifier and application proof fixtures\n'
printf '  8. Generate canonical domain-separated message vectors\n'
printf '  9. Format generated Solidity sources\n'
printf ' 10. forge build\n'
printf ' 11. forge test -vv\n'
printf ' 12. Run focused gateway, verifier, and identity application tests\n'
printf ' 13. Deploy verifier, adapter, SourceGateway, and IdentityApplicationA\n'
printf ' 14. Preserve nullifier, policy epoch, and revocation verification\n'
printf ' 15. Verify protocol type-tag and source/destination domain separation\n'
printf ' 16. Verify source/destination gateway separation\n'
printf ' 17. Verify direct SourceGateway messages and nonce progression\n'
printf ' 18. Verify Application A destination gateway forwarding\n'
printf ' 19. Decode and validate the Application A CrossChainMessage event\n'
printf ' 20. Recompute message IDs with deadline binding\n'
printf ' 21. Verify zero destination gateway rejection\n'
printf ' 22. Verify expired deadline rejection without nonce consumption\n'
printf ' 23. Verify invalid destination domain and receiver reverts\n'

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

cd "$CONTRACTS_DIR"

CURRENT_STEP="generated Solidity source formatting"
printf '\n[%s]\n' "$CURRENT_STEP"
forge fmt \
    generated/Groth16Verifier.sol \
    generated/CredentialProofFixture.sol \
    generated/CanonicalMessageVector.sol

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
CHAIN_A_RPC_URL="$CHAIN_A_RPC" \
CHAIN_A_EXPECTED_ID="$CHAIN_A_ID" \
VERIFIER_DEPLOYER_KEY="$ANVIL_DEV_KEY" \
APPLICATION_MAX_PROOF_AGE="$APPLICATION_MAX_PROOF_AGE" \
CREDENTIAL_STATE_AUTHORITY="$SOURCE_SENDER" \
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
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$SOURCE_SENDER" \
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
        "$SOURCE_SENDER" \
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
        "$SOURCE_SENDER" \
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
send_message
FIRST_TX_HASH="$LAST_TX_HASH"

CURRENT_STEP="first message event verification"
verify_message_event \
    "$FIRST_TX_HASH" \
    "$FIRST_EXPECTED_MESSAGE_ID" \
    1 \
    "$SOURCE_SENDER" \
    "$MESSAGE_DEADLINE" \
    "first message"

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
        "computeMessageId(address,uint256,address,address,uint256,bytes32,uint256)(bytes32)" \
        "$SOURCE_SENDER" \
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

printf 'Verified that nonce 1 and nonce 2 produce different message IDs.\n'

CURRENT_STEP="second message send"
printf '\n[%s]\n' "$CURRENT_STEP"
send_message
SECOND_TX_HASH="$LAST_TX_HASH"

CURRENT_STEP="second message event verification"
verify_message_event \
    "$SECOND_TX_HASH" \
    "$SECOND_EXPECTED_MESSAGE_ID" \
    2 \
    "$SOURCE_SENDER" \
    "$MESSAGE_DEADLINE" \
    "second message"

CURRENT_STEP="nonce verification after second message"
printf '\n[%s]\n' "$CURRENT_STEP"
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "3" \
    "nonce after second message"

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

CURRENT_STEP="expired Application A message rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
EXPIRED_MESSAGE_DEADLINE="$(cast block latest --field timestamp --rpc-url "$CHAIN_A_RPC")"
if cast call "$IDENTITY_APPLICATION_ADDRESS" \
    "sendCrossChainMessage(uint256,address,address,bytes,uint256)(bytes32,uint256)" \
    "$CHAIN_B_ID" \
    "$DESTINATION_GATEWAY" \
    "$DESTINATION_RECEIVER" \
    "$PAYLOAD" \
    "$EXPIRED_MESSAGE_DEADLINE" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"; then
    fail "expired Application A message unexpectedly succeeded"
else
    printf 'EXPECTED FAILURE: expired deadline rejected\n'
fi
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "4" \
    "nonce after expired deadline rejection"

CURRENT_STEP="zero destination gateway rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
if cast call "$SOURCE_GATEWAY" \
    "sendMessage(uint256,address,address,bytes,uint256)(bytes32,uint256)" \
    "$CHAIN_B_ID" \
    "$ZERO_ADDRESS" \
    "$DESTINATION_RECEIVER" \
    "$PAYLOAD" \
    "$MESSAGE_DEADLINE" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"; then
    fail "zero destination gateway call unexpectedly succeeded"
else
    printf 'EXPECTED FAILURE: zero destination gateway rejected\n'
fi
assert_equal \
    "$(cast call "$SOURCE_GATEWAY" "nextNonce()(uint256)" --rpc-url "$CHAIN_A_RPC")" \
    "4" \
    "nonce after zero destination gateway rejection"

CURRENT_STEP="same-chain destination rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
if cast call "$SOURCE_GATEWAY" \
    "sendMessage(uint256,address,address,bytes,uint256)(bytes32,uint256)" \
    "$CHAIN_A_ID" \
    "$DESTINATION_GATEWAY" \
    "$DESTINATION_RECEIVER" \
    "$PAYLOAD" \
    "$MESSAGE_DEADLINE" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"; then
    fail "same-chain destination call unexpectedly succeeded"
else
    printf 'Verified rejection of the source domain as destination domain.\n'
fi

CURRENT_STEP="zero destination receiver rejection"
printf '\n[%s]\n' "$CURRENT_STEP"
if cast call "$SOURCE_GATEWAY" \
    "sendMessage(uint256,address,address,bytes,uint256)(bytes32,uint256)" \
    "$CHAIN_B_ID" \
    "$DESTINATION_GATEWAY" \
    "$ZERO_ADDRESS" \
    "$PAYLOAD" \
    "$MESSAGE_DEADLINE" \
    --from "$SOURCE_SENDER" \
    --rpc-url "$CHAIN_A_RPC"; then
    fail "zero destination receiver call unexpectedly succeeded"
else
    printf 'Verified rejection of the zero destination receiver.\n'
fi

CURRENT_STEP="complete"
