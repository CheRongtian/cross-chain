// Demonstration checks read actual public surfaces without changing authority.
import assert from "node:assert/strict";
import { fetchMessageView } from "../../public/explorer/client.js";
import { renderMessageView } from "../../public/explorer/render.js";
import { httpJson,jsonText } from "./tools.mjs";

export function assertNoPrivateCredential(value,privateCredential,label) {
  const text = typeof value === "string" ? value : jsonText(value);
  const lower = text.toLowerCase();
  // Full high-entropy UTF-8 sentinels and full 32-byte circuit encodings avoid
  // false positives from role=1, small integers or arbitrary short substrings.
  for (const key of ["subject","credentialId"]) {
    const raw = privateCredential.credential[key];
    assert.ok(!text.includes(raw),`${label}: private ${key} text leaked`);
    assert.ok(!lower.includes(Buffer.from(raw,"utf8").toString("hex")),`${label}: private ${key} UTF-8 encoding leaked`);
  }
  for (const key of ["subject","credentialId","expiry"]) {
    const word = privateCredential.encoded[key].toString(16).padStart(64,"0");
    assert.ok(!lower.includes(word),`${label}: private ${key} circuit encoding leaked`);
    assert.ok(!text.includes(privateCredential.encoded[key].toString()),`${label}: private ${key} decimal field leaked`);
  }
  for (const key of ["statePathElements","statePathIndices","raw_signed_transaction"]) assert.ok(!text.includes('"' + key + '"'),`${label}: private/internal field leaked`);
}

// Exercise the real renderer through a text-only DOM sink. This is data-path
// verification, not a claim that a headless browser or screenshots were used.
export function renderExplorerText(view) {
  class TextElement {
    children = []; value = "";
    set textContent(value) { this.value = String(value); this.children = []; }
    get textContent() { return this.value + this.children.map(child => child.textContent).join("\n"); }
    set innerHTML(value) { throw new Error("Explorer markup insertion is forbidden"); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.value = ""; this.children = children; }
    setAttribute() {}
  }
  const document = { createElement() { return new TextElement(); } };
  const target = document.createElement("main"); renderMessageView(document,target,view); return target.textContent;
}

export async function inspectLocalPrivacy({ config,messageId,privateCredential,destination,progress }) {
  assertNoPrivateCredential(destination,privateCredential,"destination calldata/events/state");
  const body = await httpJson(config.api + "/api/v1/messages/" + messageId);
  const list = await httpJson(config.api + "/api/v1/messages");
  assert.ok(list.items.some(value => value.messageId === messageId),"real message must be discoverable in the Explorer list");
  assertNoPrivateCredential({ body,list },privateCredential,"API detail/list");
  const rendered = await fetchMessageView(messageId,{ fetchImpl: (path,options) => fetch(config.api + path,{ ...options,signal: AbortSignal.timeout(10000) }) });
  assert.equal(rendered.state,"ready"); assert.equal(rendered.view.messageId,messageId);
  const text = renderExplorerText(rendered.view);
  assert.ok(text.includes(messageId)); assert.ok(text.includes("CONFIRMED"));
  assertNoPrivateCredential(text,privateCredential,"actual Explorer view-model/renderer");
  for (const path of ["/?messageId=" + messageId,"/assets/explorer/app.js","/assets/explorer/client.js","/assets/explorer/view-model.js","/assets/explorer/render.js"]) {
    const response = await fetch(config.api + path,{ signal: AbortSignal.timeout(10000) }); assert.ok(response.ok);
    assertNoPrivateCredential(await response.text(),privateCredential,"served Explorer assets");
  }
  for (const origin of [config.api,...config.peers.map(value => value.url),...config.ports.metrics.map(port => `http://127.0.0.1:${port}`)]) {
    const response = await fetch(origin + "/metrics",{ signal: AbortSignal.timeout(10000) }); assert.ok(response.ok);
    const metrics = await response.text(); assertNoPrivateCredential(metrics,privateCredential,"live metrics");
    assert.ok(!/postgres(?:ql)?:\/\/|raw_signed_transaction|PRIVATE_KEY/.test(metrics),"metrics must not expose internal connection/signing material");
  }
  progress("Privacy: actual destination bytes/events/state, API list/detail, Explorer rendering and ten live metrics surfaces checked");
  progress("Public policy/commitments/nullifier and authorizationValidUntil are intentionally public; private subject, credential ID, exact expiry and witnesses stay local");
  return body;
}
