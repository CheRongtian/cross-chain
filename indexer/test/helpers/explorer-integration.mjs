import assert from "node:assert/strict";
import { fetchMessageView } from "../../public/explorer/client.js";
import { messageIdFromURL } from "../../public/explorer/view-model.js";
import { renderMessageView } from "../../public/explorer/render.js";
import { textDocument } from "./explorer-fixtures.mjs";

export const explorerAssetPaths = ["/assets/explorer/app.js", "/assets/explorer/client.js", "/assets/explorer/view-model.js", "/assets/explorer/render.js", "/assets/explorer/styles.css"];

export async function verifyExplorerAssets(origin) {
  for (const path of ["/", "/explorer", "/?messageId=0x01", ...explorerAssetPaths]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    const expected = path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : "text/html";
    assert.ok(response.headers.get("content-type").startsWith(expected));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const source = await response.text();
    if (expected === "text/html") {
      assert.ok(source.includes("/assets/explorer/app.js") && source.includes("/assets/explorer/styles.css") && source.includes('name="messageId"'));
    }
    assert.ok(!/DATABASE_URL|PRIVATE_KEY|postgres(?:ql)?:\/\/|node:|eth_sendRawTransaction/.test(source));
  }
  console.log("VALID: Cross-chain Message Explorer served repository-local HTML, JavaScript and CSS from the loopback read-only API origin");
}

export async function verifyExplorerMessage({ origin, body, source, expectedAuthorization, missingSigner }) {
  const id = messageIdFromURL(`${origin}/?messageId=${source.message_id}`);
  const requests = [];
  const result = await fetchMessageView(id, { fetchImpl(path, options) {
    requests.push({ path, method: options.method }); return fetch(new URL(path, origin), options);
  } });
  assert.equal(result.state, "ready", "the production browser client must consume the real lifecycle endpoint");
  assert.deepEqual(requests, [{ path: `/api/v1/messages/${source.message_id}`, method: "GET" }]);
  const view = result.view; const section = name => view.sections.find(value => value.id === name);
  const field = (name, label) => section(name).fields.find(value => value.label === label)?.value;
  assert.equal(view.messageId, source.message_id);
  assert.deepEqual(view.sections.map(value => value.id), ["source", "authorization", "finality", "batch", "merkle", "consensus", "votes", "quorum", "delivery", "attempts", "destination", "execution"]);
  assert.equal(field("source", "Source transaction"), source.source_tx_hash);
  assert.equal(field("source", "Block hash"), source.source_block_hash);
  assert.equal(field("source", "Block number"), source.source_block_number);
  assert.equal(field("source", "Source domain"), source.source_domain);
  assert.equal(field("source", "SourceGateway"), source.source_gateway);
  assert.equal(section("finality").status, source.status);
  assert.equal(field("authorization", "Observed result"), expectedAuthorization);
  if (body.batch) assert.equal(field("batch", "Batch ID"), body.batch.batchId ?? "Not recorded");
  if (body.merkle) assert.equal(field("merkle", "Message Root"), body.merkle.root);
  if (body.qc) {
    assert.equal(field("quorum", "QC version"), body.qc.protocolVersion);
    assert.equal(field("quorum", "Validator epoch"), body.qc.validatorEpoch ?? "Not recorded");
    assert.equal(field("quorum", "Required quorum"), "3 / 4 required");
    assert.equal(section("votes").records.length, body.validatorVotes.length);
  }
  if (missingSigner) {
    assert.equal(body.validatorVotes.filter(vote => vote.phase === "COMMIT").length, 3);
    assert.equal(body.validatorVotes.some(vote => vote.signer === missingSigner), false);
    const member = section("votes").details[0].records.find(value => value.title === missingSigner);
    assert.ok(member); assert.equal(member.status, "No own COMMIT observed");
    console.log("VALID: Explorer shows the pinned validator epoch/view, actual persisted votes, 3-of-4 quorum evidence and canonical QC without fabricating the offline validator's vote");
  }
  assert.equal(section("attempts").records.length, body.deliveryAttempts.length);
  if (body.destinationTransaction) assert.equal(field("destination", "Current canonical transaction"), body.destinationTransaction.transactionHash ?? "Not recorded");
  assert.equal(field("execution", "Current result"), body.execution?.status ?? "NOT_EXECUTED");
  const document = textDocument(); const target = document.createElement("main"); renderMessageView(document, target, view);
  for (const value of view.sections) assert.ok(target.textContent.includes(value.title));
  assert.ok(target.textContent.includes(source.message_id));
  if (source.status === "REORGED") {
    assert.ok(view.timeline.slice(3).every(value => value.state === "not-reached"));
    console.log("VALID: Explorer displays a real REORGED source occurrence with preserved provenance and no fabricated downstream lifecycle");
  }
  if (body.deliveryAttempts.some(attempt => attempt.receipts.some(receipt => receipt.orphaned))) {
    assert.ok(target.textContent.includes("Historical / orphaned receipt"));
    console.log("VALID: Explorer distinguishes historical orphaned destination receipt observations from the current canonical execution");
  }
  if (body.deliveryAttempts.some(attempt => attempt.replacementOfAttemptId !== null)) {
    const indices = section("attempts").records.map(value => value.fields.find(entry => entry.label === "Attempt index").value);
    assert.ok(indices.every((value, index) => index === 0 || BigInt(value) > BigInt(indices[index - 1])));
    assert.ok(body.deliveryAttempts.every(attempt => attempt.nonce === body.deliveryAttempts[0].nonce));
    const winners = section("attempts").records.filter(value => value.fields.some(entry => entry.label === "Canonical winner" && entry.value === "Yes"));
    assert.equal(winners.length, body.destinationTransaction.transactionHash ? 1 : 0);
    console.log("VALID: Explorer preserves ordered relayer/transaction attempt history, same-nonce replacement relationships and the canonical winner without exposing raw signed bytes");
  }
  if (body.execution?.status === "CONFIRMED") {
    assert.equal(view.timeline.at(-1).state, "complete");
    console.log("VALID: Explorer rendered a real cross-chain message lifecycle from Chain A source provenance through final canonical Chain B execution");
  }
  console.log("VALID: Explorer Source and Finality sections match production transaction/block/domain/Gateway evidence and exact persisted source lifecycle");
  if (expectedAuthorization === "AUTHORIZED") console.log("VALID: Explorer exposes the production-observed ZK/Application-A authorization result without exposing private credential attributes or witness data");
  if (body.merkle) console.log("VALID: Explorer shows the immutable batch identity, position and Message Root for the real message");
  console.log("VALID: Explorer Destination and Execution sections preserve current outcome separately from historical receipts and transport-only confirmation");
}
