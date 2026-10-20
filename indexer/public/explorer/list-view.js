import { messageURL, normalizeMessageId, protocolIntegerText } from "./view-model.js";

export function normalizeListCursor(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error("INVALID_LIST_CURSOR");
  return value;
}

export function listCursorFromURL(value) {
  const parameters = new URL(value, "http://localhost").searchParams;
  const values = parameters.getAll("before");
  if (values.length > 1) throw new Error("INVALID_LIST_CURSOR");
  return normalizeListCursor(values[0] ?? null);
}

export function messageListURL(value, cursor = null) {
  const url = new URL(value, "http://localhost");
  url.searchParams.delete("messageId");
  url.searchParams.delete("before");
  if (normalizeListCursor(cursor) !== null) url.searchParams.set("before", cursor);
  url.hash = "";
  return `${url.pathname}${url.search}`;
}

export function buildMessageList(data) {
  const invalid = () => { throw new Error("INCONSISTENT_MESSAGE_LIST"); };
  if (!data || data.apiVersion !== "1" || data.authority !== "OBSERVATIONAL" || !Array.isArray(data.items) ||
    data.items.length > 100 || typeof data.observedAt !== "string" || !Number.isFinite(Date.parse(data.observedAt))) invalid();
  const nextCursor = normalizeListCursor(data.nextCursor);
  if (!data.items.length && nextCursor !== null) invalid();
  const seen = new Set();
  const items = data.items.map(value => {
    if (!value || typeof value.messageId !== "string" || normalizeMessageId(value.messageId) !== value.messageId || seen.has(value.messageId) ||
      !["OBSERVED", "FINALIZING", "FINALIZED", "REORGED"].includes(value.sourceStatus) ||
      typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) invalid();
    seen.add(value.messageId);
    return { messageId: value.messageId, sourceDomain: protocolIntegerText(value.sourceDomain),
      destinationDomain: protocolIntegerText(value.destinationDomain), sourceStatus: value.sourceStatus, observedAt: value.observedAt };
  });
  return { items, nextCursor, observedAt: data.observedAt };
}

export function renderMessageList(document, target, page, { currentURL = "/", onNavigate, onCopy = () => {} } = {}) {
  const node = (tag, text, className) => {
    const result = document.createElement(tag);
    if (text != null) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  if (!page.items.length) {
    const empty = node("div", null, "empty-state");
    empty.append(node("h3", "No messages yet"), node("p", "No messages were found on this page in the configured source scope. Refresh the list or return to the latest messages.", "hint"));
    target.replaceChildren(empty); return;
  }
  const list = node("ol", null, "message-list");
  for (const item of page.items) {
    const row = node("li", null, "message-row");
    const identity = node("div", null, "message-identity");
    const link = node("a", `${item.messageId.slice(0, 12)}…${item.messageId.slice(-8)}`, "hash message-link");
    link.setAttribute("href", messageURL(messageListURL(currentURL, listCursorFromURL(currentURL)), item.messageId));
    link.setAttribute("aria-label", `View message ${item.messageId}`);
    link.setAttribute("title", item.messageId);
    link.addEventListener("click", event => {
      if (!onNavigate || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onNavigate(item.messageId);
    });
    identity.append(link);
    const full = node("details", null, "full-message-id");
    full.append(node("summary", "Full ID"), node("code", item.messageId)); identity.append(full);
    const metadata = node("dl", null, "message-metadata");
    const fields = [["First observed", new Date(item.observedAt).toLocaleString()],
      ["Route", `Chain ${item.sourceDomain} → Chain ${item.destinationDomain}`], ["Source status", item.sourceStatus]];
    for (const [label, value] of fields) {
      const field = node("div"); field.append(node("dt", label), node("dd", value)); metadata.append(field);
    }
    const actions = node("div", null, "message-actions");
    for (const [label, kind] of [["Copy ID", "id"], ["Copy link", "link"]]) {
      const button = node("button", label, "secondary compact"); button.setAttribute("type", "button");
      button.setAttribute("aria-label", `${label} for message ${item.messageId}`);
      button.addEventListener("click", () => onCopy(item.messageId, kind)); actions.append(button);
    }
    row.append(identity, metadata, actions); list.append(row);
  }
  target.replaceChildren(list);
}
