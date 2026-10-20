import { normalizeMessageId, buildMessageView } from "./view-model.js";

export function queryErrorText(status) {
  if (status === 400) return "Invalid message ID. Use 0x followed by exactly 64 hex digits.";
  if (status === 404) return "Message not found. Check the message ID and configured source scope.";
  if (status === 409) return "Explorer received inconsistent lifecycle data.";
  if (status === 503) return "Explorer data is temporarily unavailable. Protocol processing is independent of this Explorer.";
  return "Unable to load message lifecycle. Please try again. Protocol processing is independent of this Explorer.";
}

export async function fetchMessageView(messageId, { fetchImpl = globalThis.fetch, signal } = {}) {
  const id = normalizeMessageId(messageId);
  const response = await fetchImpl(`/api/v1/messages/${id}`, { method: "GET", credentials: "omit", cache: "no-store", signal });
  if (!response.ok) return { state: "error", message: queryErrorText(response.status), messageId: id };
  const data = await response.json();
  try { return { state: "ready", messageId: id, view: buildMessageView(data, id) }; }
  catch { return { state: "error", messageId: id, message: queryErrorText(409) }; }
}

export function createSearchController({ fetchImpl = globalThis.fetch, onState }) {
  let generation = 0; let active;
  const cancel = () => { generation++; active?.abort(); active = undefined; };
  return { cancel, async search(value) {
    cancel(); const current = generation;
    let id;
    try { id = normalizeMessageId(value); }
    catch { onState({ state: "invalid", message: queryErrorText(400) }); return; }
    active = new AbortController();
    const signal = AbortSignal.any([active.signal, AbortSignal.timeout(15000)]);
    onState({ state: "loading", messageId: id, message: "Loading message lifecycle…" });
    try {
      const state = await fetchMessageView(id, { fetchImpl, signal });
      if (current === generation) onState(state);
    } catch {
      if (current === generation) onState({ state: "error", messageId: id, message: queryErrorText(500) });
    } finally { if (current === generation) active = undefined; }
  } };
}
