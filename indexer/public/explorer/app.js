import { createSearchController, createMessageListController, queryErrorText } from "./client.js";
import { messageIdFromURL, messageURL, normalizeMessageId } from "./view-model.js";
import { listCursorFromURL, messageListURL, renderMessageList } from "./list-view.js";
import { renderMessageView } from "./render.js";

export function startExplorer({ document = globalThis.document, window = globalThis.window,
  fetchImpl = globalThis.fetch, clipboard = globalThis.navigator?.clipboard } = {}) {
  const element = id => document.getElementById(id);
  const input = element("message-id"); const target = element("message-view");
  const status = element("search-status"); const list = element("message-list");
  const panel = element("message-list-panel"); const listStatus = element("list-status");
  const older = element("older-messages"); const latest = element("latest-messages");
  const navigation = element("detail-navigation"); const back = element("back-to-messages");
  const copyStatus = element("copy-status"); const submit = element("search-submit");
  let nextCursor = null; let selectedId = null;

  const controller = createSearchController({ fetchImpl, onState(value) {
    target.setAttribute("aria-busy", value.state === "loading" ? "true" : "false");
    input.setAttribute("aria-invalid", value.state === "invalid" ? "true" : "false");
    submit.disabled = value.state === "loading";
    if (value.state === "ready") {
      renderMessageView(document, target, value.view);
      status.textContent = `Message loaded. Current observation: ${value.view.status}.`;
    } else { target.replaceChildren(); status.textContent = value.message; }
  } });
  const listController = createMessageListController({ fetchImpl, onState(value) {
    list.setAttribute("aria-busy", value.state === "loading" ? "true" : "false");
    nextCursor = value.state === "ready" ? value.page.nextCursor : null;
    older.disabled = nextCursor === null;
    if (value.state === "ready") {
      renderMessageList(document, list, value.page, { currentURL: window.location.href,
        onNavigate: selectMessage, onCopy: copyMessage });
      listStatus.textContent = value.page.items.length ? `${value.page.items.length} messages shown. Observed ${new Date(value.page.observedAt).toLocaleString()}.` : "No messages on this page.";
    } else { list.replaceChildren(); listStatus.textContent = value.message; }
  } });

  function currentCursor() {
    try { return listCursorFromURL(window.location.href); }
    catch { return null; }
  }
  function navigate(url) {
    window.history.pushState(null, "", url); loadURL();
  }
  function selectMessage(id) {
    navigate(messageURL(messageListURL(window.location.href, currentCursor()), id));
    target.focus();
  }
  async function copyMessage(id, kind) {
    const route = window.location.href;
    const text = kind === "id" ? id : new URL(messageURL(messageListURL(route, currentCursor()), id), route).href;
    try {
      if (typeof clipboard?.writeText !== "function") throw new Error();
      await clipboard.writeText(text);
      if (window.location.href === route) copyStatus.textContent = kind === "id" ? "Message ID copied." : "Message link copied.";
    } catch {
      if (window.location.href === route) copyStatus.textContent = "Clipboard unavailable. Expand Full ID to select it, or copy a message page URL from your browser.";
    }
  }
  function search(event) {
    event?.preventDefault();
    if (!input.value.trim()) { navigate(messageListURL(window.location.href)); return; }
    try { selectMessage(normalizeMessageId(input.value)); }
    catch { void controller.search(input.value); }
  }
  function refresh() { loadURL(); }
  function loadURL() {
    controller.cancel(); listController.cancel();
    selectedId = null; nextCursor = null; older.disabled = true; submit.disabled = false;
    input.setAttribute("aria-invalid", "false"); status.textContent = ""; copyStatus.textContent = "";
    target.replaceChildren(); target.hidden = true; navigation.hidden = true; panel.hidden = false;
    latest.setAttribute("href", messageListURL(window.location.href));
    try {
      const cursor = listCursorFromURL(window.location.href);
      const id = messageIdFromURL(window.location.href);
      latest.hidden = cursor === null;
      if (id) {
        selectedId = id; input.value = id; panel.hidden = true; target.hidden = false; navigation.hidden = false;
        back.setAttribute("href", messageListURL(window.location.href, cursor));
        void controller.search(id);
      } else { input.value = ""; void listController.load(cursor); }
    } catch {
      latest.hidden = false; input.value = new URL(window.location.href).searchParams.get("messageId") ?? "";
      input.setAttribute("aria-invalid", input.value ? "true" : "false");
      list.setAttribute("aria-busy", "false"); list.replaceChildren();
      listStatus.textContent = "Invalid page or message ID. Return to the latest messages.";
      if (input.value) status.textContent = queryErrorText(400);
    }
  }
  function follow(event) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate(event.currentTarget.getAttribute("href")); list.focus();
  }
  function nextPage() { if (nextCursor) { navigate(messageListURL(window.location.href, nextCursor)); list.focus(); } }
  function copySelected() { if (selectedId) void copyMessage(selectedId, "link"); }
  function cancel() { controller.cancel(); listController.cancel(); }
  const handlers = [[element("message-search"), "submit", search], [element("refresh"), "click", refresh],
    [older, "click", nextPage], [latest, "click", follow], [back, "click", follow],
    [element("copy-message-link"), "click", copySelected], [window, "popstate", loadURL], [window, "pagehide", cancel]];
  for (const [owner, type, handler] of handlers) owner.addEventListener(type, handler);
  loadURL();
  return { close() { cancel(); for (const [owner, type, handler] of handlers) owner.removeEventListener(type, handler); } };
}

if (typeof document !== "undefined" && typeof window !== "undefined") startExplorer();
