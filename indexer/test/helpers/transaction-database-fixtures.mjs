import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";
import { createCanonicalStore, createDatabaseStore, createFinalityStore,readCursor } from "../../src/db.mjs";
import { createDeliveryProjector } from "../../src/delivery/projector.mjs";
import { deliveryFixture, fixtureHash } from "./delivery-fixtures.mjs";

export async function persistReadyTransactionFixture({ config, pool, multiDestination = false,count = 3,
  epoch = 23n,messageOffset = 0,append = false }) {
  if (!append) {
    await createDatabaseStore(pool, config.databaseSchema).loadOrInitializeCursor(config, 10n);
    await createCanonicalStore(pool, config.databaseSchema).bootstrapCanonicalHistory(config, {
      expectedNextBlock: 10n, blocks: [{ number: 9n, hash: fixtureHash(10), parentHash: fixtureHash(9) }] });
  }
  const block = append ? BigInt((await readCursor(pool,config.databaseSchema,config)).next_block) : 10n;
  const fixture = await deliveryFixture({ multiDestination,count,epoch,messageOffset,sourceBlockNumber: block });
  await createDatabaseStore(pool, config.databaseSchema).persistRange(config, { fromBlock: block, toBlock: block,
    blocks: [{ number: block, hash: fixtureHash(block + 1n), parentHash: fixtureHash(block) }],
    rows: fixture.batch.messages.map(message => ({ ...message, payload: Buffer.from(message.payload.slice(2), "hex") })) });
  await createFinalityStore(pool, config.databaseSchema).advanceFinality(config, { headBlock: block, finalityBlockDepth: 0n });
  const lifecycle = createBatchLifecycle({ config, pool });
  const collected = await lifecycle.collectEligible(append ? {} : { initialEpoch: fixture.record.epoch });
  const id = collected.snapshot.record.batchRecordId;
  await lifecycle.sealBatch({ batchRecordId: id });
  await lifecycle.markConsensusPending({ batchRecordId: id });
  const snapshot = await lifecycle.commitWithCertificate({ certificate: fixture.quorumCertificate });
  await createDeliveryProjector({ config, pool }).materializeBatch({ batchRecordId: id });
  return { snapshot, lifecycle };
}
