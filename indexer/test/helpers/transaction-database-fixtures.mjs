import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";
import { createCanonicalStore, createDatabaseStore, createFinalityStore } from "../../src/db.mjs";
import { createDeliveryProjector } from "../../src/delivery/projector.mjs";
import { deliveryFixture, fixtureHash } from "./delivery-fixtures.mjs";

export async function persistReadyTransactionFixture({ config, pool }) {
  await createDatabaseStore(pool, config.databaseSchema).loadOrInitializeCursor(config, 10n);
  await createCanonicalStore(pool, config.databaseSchema).bootstrapCanonicalHistory(config, {
    expectedNextBlock: 10n, blocks: [{ number: 9n, hash: fixtureHash(10), parentHash: fixtureHash(9) }] });
  const fixture = await deliveryFixture();
  await createDatabaseStore(pool, config.databaseSchema).persistRange(config, { fromBlock: 10n, toBlock: 10n,
    blocks: [{ number: 10n, hash: fixtureHash(11), parentHash: fixtureHash(10) }],
    rows: fixture.batch.messages.map(message => ({ ...message, payload: Buffer.from(message.payload.slice(2), "hex") })) });
  await createFinalityStore(pool, config.databaseSchema).advanceFinality(config, { headBlock: 10n, finalityBlockDepth: 0n });
  const lifecycle = createBatchLifecycle({ config, pool });
  const collected = await lifecycle.collectEligible({ initialEpoch: fixture.record.epoch });
  const id = collected.snapshot.record.batchRecordId;
  await lifecycle.sealBatch({ batchRecordId: id });
  await lifecycle.markConsensusPending({ batchRecordId: id });
  const snapshot = await lifecycle.commitWithCertificate({ certificate: fixture.quorumCertificate });
  await createDeliveryProjector({ config, pool }).materializeBatch({ batchRecordId: id });
  return { snapshot, lifecycle };
}
