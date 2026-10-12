import { protocolInteger } from "./committee.mjs";

const MAX_TIMEOUT_MS = 2147483647;

// A fixed timeout can keep honest nodes chasing newer targets after delivery
// heals. Later rounds need a longer overlap for NEW_VIEW and its voting phases.
// Derive the window from durable views so restart never resets the backoff.
export function viewTimeoutDuration(state, baseMs) {
  const round = protocolInteger(state.changing_view ? state.target_view : state.current_view, "timeout view");
  if (round >= 31n) return MAX_TIMEOUT_MS;
  const duration = BigInt(baseMs) * (1n << round);
  return Number(duration > BigInt(MAX_TIMEOUT_MS) ? BigInt(MAX_TIMEOUT_MS) : duration);
}

export function viewTimeoutDeadline(state, baseMs) {
  const start = new Date(state.changing_view ? state.view_change_at : state.progress_at).getTime();
  return start + viewTimeoutDuration(state, baseMs);
}
