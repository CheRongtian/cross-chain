#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CHAIN_A_PORT="${CHAIN_A_PORT:-4545}"
CHAIN_B_PORT="${CHAIN_B_PORT:-9545}"
CHAIN_LOG_DIR="${CHAIN_LOG_DIR:-$ROOT_DIR}"

CHAIN_A_ID=10011
CHAIN_B_ID=2001

cleanup() {
    trap - EXIT INT TERM
    echo
    echo "Stopping local chains..."

    if [[ -n "${CHAIN_A_PID:-}" ]]; then
        kill "$CHAIN_A_PID" 2>/dev/null || true
    fi

    if [[ -n "${CHAIN_B_PID:-}" ]]; then
        kill "$CHAIN_B_PID" 2>/dev/null || true
    fi
    wait 2>/dev/null || true
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting Chain A..."
anvil \
    --host 127.0.0.1 \
    --chain-id "$CHAIN_A_ID" \
    --port "$CHAIN_A_PORT" \
    > "$CHAIN_LOG_DIR/chain-a.log" 2>&1 &

CHAIN_A_PID=$!

echo "Starting Chain B..."
anvil \
    --host 127.0.0.1 \
    --chain-id "$CHAIN_B_ID" \
    --port "$CHAIN_B_PORT" \
    > "$CHAIN_LOG_DIR/chain-b.log" 2>&1 &

CHAIN_B_PID=$!

echo
echo "Chain A"
echo "  Chain ID: $CHAIN_A_ID"
echo "  RPC:      http://127.0.0.1:$CHAIN_A_PORT"
echo
echo "Chain B"
echo "  Chain ID: $CHAIN_B_ID"
echo "  RPC:      http://127.0.0.1:$CHAIN_B_PORT"
echo
echo "Press Ctrl+C to stop both chains."

wait
