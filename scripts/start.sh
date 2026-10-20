#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

printf 'Starting the read-only Cross-Chain Explorer and Message Query API...\n'
printf 'The API loads the root .env and prints its Explorer URL when ready.\n'
printf 'Keep this terminal running. Press Ctrl+C to stop.\n\n'

# Reuse the existing startup entry; no verification, deployment or installation.
# Its output stays in this terminal and never overwrites verification.log.
exec npm --prefix "$PROJECT_ROOT/indexer" run api:start
