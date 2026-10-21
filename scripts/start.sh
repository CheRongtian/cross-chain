#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Return after the complete owned stack and one confirmed Explorer message are
# ready. The supervisor and normal background workers keep running.
exec node "$PROJECT_ROOT/indexer/scripts/local/main.mjs" start
