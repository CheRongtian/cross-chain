#!/usr/bin/env bash

set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CHAIN_A_PORT=4545
CHAIN_B_PORT=9545

CHAIN_A_ID=10011
CHAIN_B_ID=2001

cleanup() {
    echo
    echo "Stopping local chains..."

    if [[ -n "${CHAIN_A_PID:-}" ]]; then
        kill "$CHAIN_A_PID" 2>/dev/null || true
    fi

    if [[ -n "${CHAIN_B_PID:-}" ]]; then
        kill "$CHAIN_B_PID" 2>/dev/null || true
    fi
}

trap cleanup EXIT INT TERM

echo "Starting Chain A..."
anvil \
    --chain-id "$CHAIN_A_ID" \
    --port "$CHAIN_A_PORT" \
    > "$ROOT_DIR/chain-a.log" 2>&1 &

CHAIN_A_PID=$!

echo "Starting Chain B..."
anvil \
    --chain-id "$CHAIN_B_ID" \
    --port "$CHAIN_B_PORT" \
    > "$ROOT_DIR/chain-b.log" 2>&1 &

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