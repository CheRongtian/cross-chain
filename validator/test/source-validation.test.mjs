import assert from "node:assert/strict";
import test from "node:test";
import { createBatchValidationService } from "../src/source-validation.mjs";
import { chainFixture, configuration, snapshotFixture } from "./helpers/fixtures.mjs";

function serviceFixture(snapshot, client = chainFixture(snapshot), config = configuration()) {
  const saved = [];
  const service = createBatchValidationService({ config, publicClient: client,
    reader: { async read() { return snapshot; } },
    store: { async recordObservation(observation) { saved.push(observation); return { validated_at: new Date("2026-01-01T00:00:00Z") }; } },
  });
  return { service, client, saved };
}

for (const status of ["SEALED", "CONSENSUS_PENDING"]) {
  test(`${status} independently rechecks every raw source event using one exact large head`, async () => {
    const snapshot = await snapshotFixture(status);
    const { service, client, saved } = serviceFixture(snapshot);
    const result = await service.validate(snapshot.record.batchId);
    assert.equal(result.result, "VALID");
    assert.equal(result.sourceHeadNumber, client.head.number.toString());
    assert.equal(client.calls.latestHeads, 1);
    assert.equal(client.calls.receipts.length, snapshot.batch.messages.length);
    assert.equal(saved[0].head.number, snapshot.batch.messages[0].sourceBlockNumber + 2n);
    assert.equal(saved[0].result, "VALID");
  });
}

test("exact finality threshold succeeds, one block before and above-head source reject", async () => {
  const snapshot = await snapshotFixture();
  const sourceBlock = snapshot.batch.messages[0].sourceBlockNumber;
  for (const [head, expected] of [[sourceBlock + 2n, "VALID"], [sourceBlock + 1n, "INVALID"], [sourceBlock - 1n, "INVALID"]]) {
    const { service } = serviceFixture(snapshot, chainFixture(snapshot, head));
    assert.equal((await service.validate(snapshot.record.batchId)).result, expected);
  }
});

test("canonical block, raw log signature, fields, receipt, and fixed-head mismatch reject", async () => {
  for (const mutation of ["block", "head", "receipt", "log", "signature", "address", "metadata"]) {
    const snapshot = await snapshotFixture();
    const client = chainFixture(snapshot);
    const originalBlock = client.getBlock.bind(client);
    const originalReceipt = client.getTransactionReceipt.bind(client);
    client.getBlock = async (input) => {
      const block = await originalBlock(input);
      if ((mutation === "block" && input.blockNumber === snapshot.batch.messages[0].sourceBlockNumber) ||
          (mutation === "head" && input.blockNumber === client.head.number)) block.hash = `0x${"ee".repeat(32)}`;
      return block;
    };
    client.getTransactionReceipt = async (input) => {
      const receipt = await originalReceipt(input);
      if (mutation === "receipt") receipt.status = "reverted";
      if (mutation === "log") receipt.logs[0].data = "0x";
      if (mutation === "signature") receipt.logs[0].topics[0] = `0x${"ee".repeat(32)}`;
      if (mutation === "address") receipt.logs[0].address = "0x0000000000000000000000000000000000009999";
      if (mutation === "metadata") receipt.logs[0].transactionHash = `0x${"ee".repeat(32)}`;
      return receipt;
    };
    assert.equal((await serviceFixture(snapshot, client).service.validate(snapshot.record.batchId)).result, "INVALID", mutation);
  }
});

test("malformed, reordered, duplicate, wrong-root/context, building, and non-finalized candidates reject", async () => {
  const original = await snapshotFixture();
  const candidates = [
    { ...original, record: { ...original.record, status: "BUILDING" } },
    { ...original, record: { ...original.record, messageRoot: `0x${"ee".repeat(32)}` } },
    { ...original, record: { ...original.record, epoch: original.record.epoch + 1n } },
    { ...original, members: original.members.map((member) => ({ ...member, position: 9n })) },
    { ...original, batch: { ...original.batch, batchId: `0x${"ee".repeat(32)}` } },
    { ...original, batch: { ...original.batch, messages: [...original.batch.messages].reverse() } },
    { ...original, batch: { ...original.batch, messages: [...original.batch.messages, original.batch.messages[0]] } },
    ...["OBSERVED", "FINALIZING", "REORGED"].map((status) => ({ ...original, batch: { ...original.batch,
      messages: [{ ...original.batch.messages[0], status }, ...original.batch.messages.slice(1)] } })),
    { ...original, batch: { ...original.batch, messages: [{ ...original.batch.messages[0], nonce: 9n }, ...original.batch.messages.slice(1)] } },
  ];
  for (const snapshot of candidates) {
    const { service, saved } = serviceFixture(snapshot, chainFixture(original));
    assert.equal((await service.validate(original.record.batchId)).result, "INVALID");
    assert.equal(saved.length, 0, "untrusted snapshot must not poison local snapshot binding");
  }
  await assert.rejects(serviceFixture(original).service.validate("0x00"));
  assert.equal((await serviceFixture(original).service.validate(`0x${"ee".repeat(32)}`)).result, "INVALID");
  const wrongScope = { ...configuration(), sourceGateway: "0x0000000000000000000000000000000000009999" };
  assert.equal((await serviceFixture(original, chainFixture(original), wrongScope).service.validate(original.record.batchId)).result, "INVALID");
});

test("wrong RPC chain, missing Gateway, and unavailable RPC cannot yield VALID", async () => {
  const snapshot = await snapshotFixture();
  for (const failure of ["chain", "gateway", "unavailable"]) {
    const client = chainFixture(snapshot);
    if (failure === "chain") client.request = async () => "0x7d1";
    if (failure === "gateway") client.getBytecode = async () => "0x";
    if (failure === "unavailable") client.request = async () => { throw new Error("offline"); };
    const { service, saved } = serviceFixture(snapshot, client);
    assert.equal((await service.validate(snapshot.record.batchId)).result, "INVALID");
    assert.equal(saved.length, 0);
  }
});
