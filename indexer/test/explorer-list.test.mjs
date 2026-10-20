import assert from "node:assert/strict";
import { test } from "node:test";
import { startExplorer } from "../public/explorer/app.js";
import { buildMessageList, listCursorFromURL, messageListURL, normalizeListCursor, renderMessageList } from "../public/explorer/list-view.js";
import { createMessageListController, fetchMessageList } from "../public/explorer/client.js";
import { explorerFixture, textDocument } from "./helpers/explorer-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";

const item = overrides => ({ messageId: fixtureHash(400), sourceDomain: "9007199254740993", destinationDomain: "2001",
  sourceStatus: "OBSERVED", observedAt: "2026-10-20T00:00:00.000Z", ...overrides });
const page = (items = [item()], nextCursor = null) => ({ apiVersion: "1", authority: "OBSERVATIONAL", observedAt: "2026-10-20T00:00:00.000Z", items, nextCursor });
const ok = body => ({ ok: true, async json() { return body; } });
const settle = () => new Promise(resolve => setImmediate(resolve));
const walk = node => [node, ...node.children.flatMap(walk)];

function browser(url = "http://127.0.0.1:8080/") {
  const document = textDocument(); const roots = new Map();
  for (const id of ["message-id", "message-view", "search-status", "message-list", "message-list-panel", "list-status", "older-messages",
    "latest-messages", "detail-navigation", "back-to-messages", "copy-status", "search-submit", "message-search", "refresh", "copy-message-link"]) {
    roots.set(id, document.createElement(id === "message-id" ? "input" : "div"));
  }
  document.getElementById = id => roots.get(id);
  const window = document.createElement("window"); window.location = { href: url };
  const entries = [url]; let position = 0;
  window.history = {
    pushState(state, title, path) {
      const next = new URL(path, window.location.href).href;
      entries.splice(position + 1); entries.push(next); position++; window.location.href = next;
    },
    back() { if (position) { window.location.href = entries[--position]; window.dispatch("popstate"); } },
  };
  return { document, window, get: id => roots.get(id) };
}

test("list URLs preserve exact cursors, clear detail selection and never require a manually entered ID", () => {
  assert.equal(normalizeListCursor("9007199254740993"), "9007199254740993");
  assert.equal(listCursorFromURL("/"), null);
  assert.equal(listCursorFromURL("/?before=9007199254740993"), "9007199254740993");
  assert.equal(messageListURL(`/?before=10&messageId=${fixtureHash(1)}#details`, "9007199254740993"), "/?before=9007199254740993");
  assert.equal(messageListURL("/explorer?before=10"), "/explorer");
  for (const cursor of ["", "0", "01", "-1", "1.5", "9223372036854775808"]) assert.throws(() => normalizeListCursor(cursor));
  assert.throws(() => listCursorFromURL("/?before=1&before=2"));
});

test("list data preserves exact domains, validates its own schema and exposes source status without inferring execution", () => {
  const value = buildMessageList(page());
  assert.equal(value.items[0].sourceDomain, "9007199254740993");
  assert.equal(Object.hasOwn(value.items[0], "execution"), false);
  for (const change of [body => { body.authority = "AUTHORITATIVE"; }, body => { body.items = {}; },
    body => { body.nextCursor = "1.5"; }, body => { body.items[0].messageId = "bad"; },
    body => { body.items[0].sourceStatus = "CONFIRMED"; }, body => { body.items[0].sourceDomain = 9007199254740992; },
    body => { body.items[0].observedAt = "not-a-date"; }, body => { body.items.push(body.items[0]); },
    body => { body.items = []; body.nextCursor = "1"; }, body => { body.items = Array.from({ length: 101 }, (_, i) => item({ messageId: fixtureHash(i) })); }]) {
    const body = page(); change(body); assert.throws(() => buildMessageList(body));
  }
});

test("list renderer has accessible real links, copy actions, complete IDs and a useful empty state", () => {
  const document = textDocument(); const target = document.createElement("div"); const copied = []; const selected = [];
  const value = buildMessageList(page());
  renderMessageList(document, target, value, { currentURL: "/?before=100", onNavigate: id => selected.push(id), onCopy: (...args) => copied.push(args) });
  assert.ok(target.textContent.includes(value.items[0].messageId)); assert.ok(target.textContent.includes("Source status"));
  assert.ok(target.textContent.includes("9007199254740993"));
  const link = walk(target).find(node => node.tagName === "a");
  assert.equal(link.getAttribute("href"), `/?before=100&messageId=${value.items[0].messageId}`);
  assert.ok(link.getAttribute("aria-label").includes(value.items[0].messageId));
  assert.equal(link.dispatch("click", { ctrlKey: true }).defaultPrevented, undefined); assert.equal(selected.length, 0);
  assert.equal(link.dispatch("click").defaultPrevented, true); assert.deepEqual(selected, [value.items[0].messageId]);
  const buttons = walk(target).filter(node => node.tagName === "button");
  for (const button of buttons) button.dispatch("click");
  assert.deepEqual(copied, [[value.items[0].messageId, "id"], [value.items[0].messageId, "link"]]);
  renderMessageList(document, target, buildMessageList(page([])));
  assert.ok(target.textContent.includes("No messages yet")); assert.ok(!target.textContent.includes("Invalid message ID"));
});

test("browser list requests are bounded GETs and failures never reflect backend details", async () => {
  const calls = [];
  const result = await fetchMessageList("9007199254740993", { fetchImpl: async (path, options) => { calls.push({ path, options }); return ok(page()); } });
  assert.equal(result.state, "ready"); assert.equal(calls[0].path, "/api/v1/messages?limit=20&before=9007199254740993");
  assert.equal(calls[0].options.method, "GET"); assert.equal(calls[0].options.credentials, "omit");
  for (const status of [400, 404, 409, 500, 503]) {
    const failed = await fetchMessageList(null, { fetchImpl: async () => ({ ok: false, status, json() { assert.fail("error body must not be rendered"); } }) });
    assert.equal(failed.state, "error");
  }
  const secret = "SERVER_DETAILS_MUST_NOT_APPEAR";
  const states = [];
  const controller = createMessageListController({ onState: state => states.push(state), fetchImpl: async () => { throw new Error(secret); } });
  await controller.load(); assert.equal(states.at(-1).state, "error"); assert.ok(!states.at(-1).message.includes(secret));
  const malformed = await fetchMessageList(null, { fetchImpl: async () => ok({ secret }) });
  assert.equal(malformed.state, "error"); assert.ok(!malformed.message.includes(secret));
});

test("superseded list responses cannot overwrite a newer page or a detail navigation", async () => {
  const pending = []; const states = [];
  const controller = createMessageListController({ onState: state => states.push(state), fetchImpl: (path, options) => new Promise(resolve => pending.push({ path, options, resolve })) });
  const first = controller.load(); const second = controller.load("100");
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve(ok(page([item({ messageId: fixtureHash(401) })]))); await second;
  pending[0].resolve(ok(page())); await first;
  assert.equal(states.at(-1).page.items[0].messageId, fixtureHash(401)); assert.equal(states.filter(state => state.state === "ready").length, 1);
  const third = controller.load(); controller.cancel();
  pending[2].resolve(ok(page())); await third;
  assert.equal(states.filter(state => state.state === "ready").length, 1);
});

test("homepage loads real list client automatically; blank search and refresh never request an empty detail ID", async () => {
  const ui = browser(); const calls = [];
  const runtime = startExplorer({ ...ui, fetchImpl: async (path, options) => { calls.push({ path, options }); return ok(page()); } });
  try {
    await settle(); assert.equal(calls.length, 1); assert.equal(calls[0].path, "/api/v1/messages?limit=20");
    assert.equal(ui.get("message-id").getAttribute("aria-invalid"), "false"); assert.equal(ui.get("message-list-panel").hidden, false);
    ui.get("refresh").dispatch("click"); await settle();
    ui.get("message-search").dispatch("submit"); await settle();
    assert.equal(calls.length, 3); assert.ok(calls.every(call => call.path === "/api/v1/messages?limit=20"));
    assert.equal(ui.get("search-status").textContent, ""); assert.equal(ui.get("message-id").getAttribute("aria-invalid"), "false");
    assert.ok(ui.get("message-list").textContent.includes(item().messageId));
    ui.get("message-id").value = "bad"; ui.get("message-search").dispatch("submit"); await settle();
    assert.equal(calls.length, 3); assert.equal(ui.get("message-id").getAttribute("aria-invalid"), "true");
    ui.get("message-id").value = ""; ui.get("refresh").dispatch("click"); await settle();
    assert.equal(ui.get("message-id").getAttribute("aria-invalid"), "false"); assert.equal(ui.get("search-status").textContent, "");
  } finally { runtime.close(); }
});

test("list clicks open details; page URLs, copying, refresh and browser back preserve navigation", async () => {
  const { body } = await explorerFixture(); const ui = browser(); const calls = []; const copied = [];
  const listPage = page([item({ messageId: body.message.messageId })], "100");
  const runtime = startExplorer({ ...ui, clipboard: { async writeText(value) { copied.push(value); } }, fetchImpl: async path => {
    calls.push(path);
    if (path.startsWith("/api/v1/messages?")) return ok(path.includes("before=") ? { ...listPage, nextCursor: null } : listPage);
    assert.equal(path, `/api/v1/messages/${body.message.messageId}`); return ok(body);
  } });
  try {
    await settle(); assert.equal(ui.get("older-messages").disabled, false);
    ui.get("older-messages").dispatch("click"); await settle();
    assert.equal(new URL(ui.window.location.href).searchParams.get("before"), "100"); assert.equal(ui.get("older-messages").disabled, true);
    const actions = walk(ui.get("message-list")).filter(node => node.tagName === "button");
    actions[0].dispatch("click"); actions[1].dispatch("click"); await settle();
    assert.equal(copied[0], body.message.messageId); assert.ok(copied[1].includes(`before=100&messageId=${body.message.messageId}`));
    walk(ui.get("message-list")).find(node => node.tagName === "a").dispatch("click"); await settle();
    assert.equal(ui.get("message-list-panel").hidden, true); assert.equal(ui.get("message-view").hidden, false);
    assert.ok(ui.get("message-view").textContent.includes(body.message.messageId));
    assert.equal(ui.get("back-to-messages").getAttribute("href"), "/?before=100");
    ui.get("message-id").value = ""; ui.get("refresh").dispatch("click"); await settle();
    assert.equal(calls.at(-1), `/api/v1/messages/${body.message.messageId}`);
    ui.get("copy-message-link").dispatch("click"); await settle(); assert.ok(ui.get("copy-status").textContent.includes("copied"));
    ui.window.history.back(); await settle();
    assert.equal(ui.get("message-list-panel").hidden, false); assert.equal(ui.get("message-view").hidden, true);
    assert.ok(calls.at(-1).includes("before=100"));
    ui.get("latest-messages").dispatch("click"); await settle(); assert.equal(new URL(ui.window.location.href).search, "");
  } finally { runtime.close(); }
});

test("no-data and invalid-URL screens offer list recovery without exposing or fabricating a message", async () => {
  const ui = browser("http://127.0.0.1:8080/?before=bad"); const calls = [];
  const runtime = startExplorer({ ...ui, fetchImpl: async path => { calls.push(path); return ok(page([])); } });
  try {
    assert.equal(calls.length, 0); assert.ok(ui.get("list-status").textContent.includes("Return to the latest messages"));
    ui.get("latest-messages").dispatch("click"); await settle();
    assert.equal(calls.length, 1); assert.ok(ui.get("message-list").textContent.includes("No messages yet"));
    assert.equal(ui.get("older-messages").disabled, true); assert.equal(ui.get("message-id").value, "");
  } finally { runtime.close(); }
});

test("a list response arriving after detail navigation cannot change the selected screen", async () => {
  const { body } = await explorerFixture(); const ui = browser(); let finishList;
  const runtime = startExplorer({ ...ui, fetchImpl: path => {
    if (path.startsWith("/api/v1/messages?")) return new Promise(resolve => { finishList = resolve; });
    return Promise.resolve(ok(body));
  } });
  try {
    ui.get("message-id").value = body.message.messageId; ui.get("message-search").dispatch("submit"); await settle();
    assert.equal(ui.get("message-view").hidden, false);
    finishList(ok(page())); await settle();
    assert.equal(ui.get("message-list-panel").hidden, true); assert.equal(ui.get("message-list").children.length, 0);
    assert.ok(ui.get("message-view").textContent.includes(body.message.messageId));
  } finally { runtime.close(); }
});

test("returning to browsing cancels pending details and clipboard failures remain actionable", async () => {
  const { body } = await explorerFixture(); const ui = browser(`http://127.0.0.1:8080/?messageId=${body.message.messageId}`); let finishDetail;
  const runtime = startExplorer({ ...ui, clipboard: { async writeText() { throw new Error("PRIVATE_CLIPBOARD_ERROR"); } }, fetchImpl: path => {
    if (path.startsWith("/api/v1/messages?")) return Promise.resolve(ok(page()));
    return new Promise(resolve => { finishDetail = resolve; });
  } });
  try {
    ui.get("back-to-messages").dispatch("click"); await settle();
    finishDetail(ok(body)); await settle();
    assert.equal(ui.get("message-view").hidden, true); assert.equal(ui.get("message-view").children.length, 0);
    const copy = walk(ui.get("message-list")).find(node => node.tagName === "button"); copy.dispatch("click"); await settle();
    assert.ok(ui.get("copy-status").textContent.includes("Clipboard unavailable"));
    assert.ok(!ui.get("copy-status").textContent.includes("PRIVATE_CLIPBOARD_ERROR"));
  } finally { runtime.close(); }
});
