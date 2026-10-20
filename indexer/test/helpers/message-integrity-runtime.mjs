import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeAbiParameters } from "viem";
import { computeCanonicalMessageId, normalizeCanonicalMessage, validateCanonicalMessage } from "../../src/canonical-message.mjs";
import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";
import { databaseRowToBatchMessage } from "../../src/message-batch.mjs";
import { tableName } from "../../src/db.mjs";
import { readSnapshot } from "../../src/api/read-snapshot.mjs";
import { encodeGatewaySubmission, ENVELOPE_PARAMETERS, MESSAGE_PARAMETERS } from "../../src/relayer/encoding.mjs";
import { canonicalDomainMessage } from "./message-domain-contract.mjs";
import { assertCanonicalIdentity, assertCommittedPackageIntegrity, canonicalFieldMutations } from "./message-integrity.mjs";

export function persistedMessageIdentity(event, row) {
  const message = databaseRowToBatchMessage(row);
  assert.equal(row.message_id, event.messageId);
  assert.deepEqual(normalizeCanonicalMessage(message), normalizeCanonicalMessage(event));
  assert.equal(computeCanonicalMessageId(message), event.messageId);
  return { messageId: event.messageId, canonical: normalizeCanonicalMessage(message) };
}

export function assertDestinationIdentity({ event, pack, packageBytes, authenticatedMessageId }) {
  const envelope = decodeAbiParameters(ENVELOPE_PARAMETERS, packageBytes);
  const [version, sourceDomain, sourceGateway, sourceSender, destinationDomain, destinationGateway, destinationReceiver,
    nonce, payload, payloadHash, deadline, messageId] = decodeAbiParameters(MESSAGE_PARAMETERS, envelope[3]);
  const message = { version, sourceDomain, sourceGateway, sourceSender, destinationDomain, destinationGateway,
    destinationReceiver, nonce, payload, payloadHash, deadline };
  assert.equal(messageId, event.messageId); assert.equal(pack.message.messageId, event.messageId);
  assert.equal(authenticatedMessageId, event.messageId);
  assert.deepEqual(normalizeCanonicalMessage(message), normalizeCanonicalMessage(event));
  assert.equal(validateCanonicalMessage(message, authenticatedMessageId).messageId, event.messageId);
  return messageId;
}

export async function verifyRealMessageIntegrity({ config, pool, snapshot, pack, validatorSets, event, checkpoints,
  client, domainVerifierAddress, captureDestination }) {
  console.log("\n[message integrity invariants / real committed evidence]");
  const names = ["source_messages", "indexer_cursors", "indexed_source_blocks", "message_batches", "message_batch_members",
    "batch_consensus_bindings", "batch_quorum_certificates", "batch_quorum_certificate_signatures", "delivery_batches", "delivery_jobs",
    "relayer_submissions", "relayer_job_leases", "transaction_accounts", "transaction_intents", "transaction_attempts",
    "transaction_broadcast_events", "transaction_receipt_observations", "transaction_receipt_orphans"];
  const capture = async () => {
    const result = {};
    for (const name of names) result[name] = (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema, name)} t ORDER BY to_jsonb(t)::text`)).rows;
    return { protocol: result, destination: await captureDestination() };
  };
  const before = await capture();
  assert.deepEqual(checkpoints.map(point => point.phase), ["SOURCE_EVENT", "OBSERVED", "FINALIZING", "FINALIZED", "SEALED", "CONSENSUS_PENDING", "COMMITTED"]);
  const canonical = assertCanonicalIdentity(event, event.messageId);
  for (const point of checkpoints) { assert.equal(point.messageId, event.messageId); assert.deepEqual(point.canonical, canonical); }
  const persisted = await readSnapshot(pool, connection => createBatchLifecycle({ config: { ...config, validatorSets }, pool })
    .readBatchObservation({ batchRecordId: snapshot.record.batchRecordId }, connection));
  assert.deepEqual(persisted, snapshot);
  const evidence = await assertCommittedPackageIntegrity({ snapshot: persisted, pack, validatorSets });
  assert.equal(evidence.original.messageId, event.messageId);
  const encoded = await encodeGatewaySubmission(pack, { validatorSets });
  assertDestinationIdentity({ event, pack, packageBytes: encoded.data, authenticatedMessageId: event.messageId });
  console.log("VALID: source, persisted OBSERVED/FINALIZING/FINALIZED, SEALED, CONSENSUS_PENDING, COMMITTED and portable message identities are identical");
  console.log("VALID: the real committed batch member reconstructs its exact canonical leaf and Message Root from immutable message evidence");
  console.log("VALID: canonical mutations change the original ID and leaf and fail its original position/path/root; duplicate replacement membership is explicitly rejected");
  console.log("VALID: the original committed message verifies under its original membership proof and committed root");
  console.log("VALID: one same-length valid payload mutation changes its payload commitment and canonical message ID");
  console.log("EXPECTED FAILURE: a mutated payload paired with the original message ID is rejected by production canonical validation");
  console.log("EXPECTED FAILURE: a payload-mutated message with a freshly recomputed ID cannot reuse the original Merkle proof/root");
  console.log(`Message integrity evidence: originalPayloadHash=${event.payloadHash} mutatedPayloadHash=${evidence.changedPayload.payloadHash} originalMessageId=${event.messageId} mutatedMessageId=${evidence.changedPayload.messageId} originalLeaf=${evidence.leaf} committedRoot=${evidence.messageRoot}`);

  const abi = JSON.parse(readFileSync(new URL("../../../contracts/out/MessageDomainVerifier.sol/MessageDomainVerifier.json", import.meta.url), "utf8")).abi;
  const solidityId = message => client.readContract({ address: domainVerifierAddress, abi, functionName: "computeMessageId", args: canonicalDomainMessage(message) });
  const frozen = JSON.parse(readFileSync(new URL("../../../test-vectors/destination-transport.json", import.meta.url), "utf8")).package.message;
  assert.equal(computeCanonicalMessageId(frozen), frozen.messageId);
  assert.equal(await solidityId(frozen), frozen.messageId);
  console.log("VALID: JavaScript and Solidity agree on the independently frozen canonical message ID, including its exact full-width deadline");
  const wide = { ...frozen, sourceDomain: (1n << 200n) + 10011n, destinationDomain: (1n << 200n) + 2001n,
    nonce: (1n << 240n) + 7n, deadline: (1n << 255n) + 3600n };
  for (const message of [event, wide]) {
    const id = computeCanonicalMessageId(message);
    assert.equal(await solidityId(message), id);
    for (const mutation of canonicalFieldMutations(message).filter(value => ["sourceDomain", "destinationDomain"].includes(value.field))) {
      assert.notEqual(mutation.message.messageId, id);
      assert.equal(await solidityId(mutation.message), mutation.message.messageId);
    }
  }
  assert.equal(await solidityId(evidence.changedPayload), evidence.changedPayload.messageId);
  console.log("VALID: isolated source-domain and destination-domain mutations produce the same distinct IDs in JavaScript and Solidity without changing unrelated fields");
  console.log("VALID: full-width uint256 domain mutations remain exact and cannot collide through JavaScript Number truncation");
  assert.deepEqual(await capture(), before, "integrity probes cannot change source/membership/root/QC/READY/transaction history or Gateway/ApplicationB state");
  await assertCommittedPackageIntegrity({ snapshot: persisted, pack, validatorSets });
  console.log("VALID: message-integrity mutation tests leave original source, membership, root, QC, READY packages, transaction history and destination state unchanged");
  console.log("VALID: the original message/proof/root/QC still verify after all integrity probes");
}
