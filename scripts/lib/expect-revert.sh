#!/usr/bin/env bash

set -euo pipefail

# Source-only verification helpers. Callers provide fail() and normalize().
# Root and credential deployment checks share this exact rejection boundary.
expect_command_revert() {
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

    if output="$("$@" 2>&1)"; then
        printf '%s\n' "$output"
        fail "$label unexpectedly succeeded"
    fi

    printf '%s\n' "$output"
    # Only actual revert reason/data can establish this rejection. A name or
    # selector in transport/CLI/context diagnostics cannot stand in for it.
    while IFS= read -r line; do
        if [[ "$line" =~ $decoded_pattern ]] || [[ "$line" =~ $selector_pattern ]]; then
            matched="true"
            break
        fi
    done <<< "$(normalize "$output")"
    [[ "$matched" == "true" ]] || fail "$label reverted without $error_signature"
    printf 'EXPECTED FAILURE: %s (%s)\n' "$label" "$error_name"
}

expect_call_revert() {
    local label="$1"
    local error_signature="$2"
    shift 2
    expect_command_revert "$label" "$error_signature" cast call "$@"
}
