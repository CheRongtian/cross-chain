#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Ready means the complete owned local protocol and observation surfaces are
# available. The supervisor persists after this short command returns.
exec node "$PROJECT_ROOT/indexer/scripts/local/main.mjs" start
