import assert from "node:assert/strict";

import {
  applyMigrations,
  createCanonicalStore,
  createDatabasePool,
  readCursor,
  readIndexedSourceBlocks,
  readMessages,
  resetIndexerTables,
} from "../../src/db.mjs";
import { createFinalityWatcher } from "../../src/finality-watcher.mjs";
import { createIndexer } from "../../src/indexer.mjs";
import { createCanonicalReconciler } from "../../src/reorg-detector.mjs";

const quiet = { log() {}, error() {} };

// Dedicated source fixture and restored Chain A snapshot leave the existing
// message A/B/C/D/E, batch, consensus and delivery scenarios unchanged.
export async function verifySourceSnapshotConcurrency({ config, publicClient, produceMessage }) {
  const chainSnapshot = await publicClient.request({ method: "evm_snapshot" });
  assert.match(chainSnapshot, /^0x[0-9a-fA-F]+$/);
  const fixtureConfig = { ...config, databaseSchema: "cross_chain_source_snapshot_verification" };
  const watcherPool = createDatabasePool(fixtureConfig);
  const indexerPool = createDatabasePool(fixtureConfig);
  try {
    await applyMigrations(watcherPool, fixtureConfig.databaseSchema);
    for (const phase of ["after-head", "after-reconciliation"]) {
      await resetIndexerTables(watcherPool, fixtureConfig.databaseSchema);
      const prefixMessage = await produceMessage("0x736e617073686f7420707265666978");
      const sourceConfig = { ...fixtureConfig, sourceGatewayStartBlock: prefixMessage.sourceBlockNumber };
      const scope = { chainDomain: config.chainDomain, sourceGateway: config.sourceGateway };
      const indexer = createIndexer({ config: sourceConfig, pool: indexerPool, publicClient, logger: quiet });
      await indexer.catchUpOnce();

      const reached = Promise.withResolvers();
      const resume = Promise.withResolvers();
      let snapshotHead;
      let reconciliation;
      let recoveryCalls = 0;
      let captured = false;
      let pending;
      const watcherClient = {
        async request(input) {
          const value = await publicClient.request(input);
          if (input.method === "eth_blockNumber" && !captured) {
            captured = true;
            snapshotHead = BigInt(value);
            if (phase === "after-head") { reached.resolve(); await resume.promise; }
          }
          return value;
        },
        getBlock(input) { return publicClient.getBlock(input); },
      };
      const canonicalStore = createCanonicalStore(watcherPool, fixtureConfig.databaseSchema);
      const recover = canonicalStore.recoverCanonicalReorg.bind(canonicalStore);
      canonicalStore.recoverCanonicalReorg = (...args) => { recoveryCalls += 1; return recover(...args); };
      const reconciler = createCanonicalReconciler({ config: sourceConfig, pool: watcherPool,
        publicClient: watcherClient, canonicalStore, logger: console });
      const watcher = createFinalityWatcher({ config: sourceConfig, pool: watcherPool, publicClient: watcherClient,
        reconciler: { async reconcile(input) {
          reconciliation = await reconciler.reconcile(input);
          if (phase === "after-reconciliation") { reached.resolve(); await resume.promise; }
          return reconciliation;
        } }, logger: console });

      try {
        pending = watcher.runFinalityPass();
        await Promise.race([reached.promise, pending.then(() => assert.fail("Watcher missed the controlled source checkpoint"))]);
        assert.equal(snapshotHead, prefixMessage.sourceBlockNumber);
        console.log(`Source concurrency checkpoint (${phase}): Watcher captured H=${snapshotHead}`);
        const nextMessage = await produceMessage("0x736e617073686f7420737563636573736f72");
        assert.equal(nextMessage.sourceBlockNumber, snapshotHead + 1n);
        const indexed = await indexer.catchUpOnce();
        assert.equal(indexed.snapshotHead, snapshotHead + 1n);
        const blocksBefore = await readIndexedSourceBlocks(watcherPool, fixtureConfig.databaseSchema, scope);
        const cursorBefore = await readCursor(watcherPool, fixtureConfig.databaseSchema, scope);
        const nextBefore = (await readMessages(watcherPool, fixtureConfig.databaseSchema)).find(row => row.message_id === nextMessage.messageId);
        assert.equal(nextBefore.status, "OBSERVED");
        assert.equal(BigInt(cursorBefore.next_block), snapshotHead + 2n);
        console.log(`Source concurrency checkpoint: Indexer committed H+1=${nextMessage.sourceBlockNumber}, cursor=${cursorBefore.next_block}`);

        resume.resolve();
        const fixedPass = await pending;
        assert.equal(fixedPass.headBlock, snapshotHead);
        assert.equal(fixedPass.candidatesChecked, 1);
        assert.equal(fixedPass.observedToFinalizing, 1);
        assert.equal(reconciliation.detected, false);
        assert.equal(recoveryCalls, 0);
        assert.deepEqual(await readIndexedSourceBlocks(watcherPool, fixtureConfig.databaseSchema, scope), blocksBefore);
        assert.deepEqual(await readCursor(watcherPool, fixtureConfig.databaseSchema, scope), cursorBefore);
        assert.deepEqual((await readMessages(watcherPool, fixtureConfig.databaseSchema)).find(row => row.message_id === nextMessage.messageId), nextBefore);
        console.log(`VALID: canonical snapshot prefix H=${snapshotHead}; no recovery; H+1 block/message and advanced cursor preserved (${phase})`);
        console.log("VALID: snapshot-bounded finality excluded the concurrently inserted H+1 occurrence");

        const nextPass = await watcher.runFinalityPass();
        assert.equal(nextPass.headBlock, snapshotHead + 1n);
        assert.equal(nextPass.observedToFinalizing, 1);
        let nextRow = (await readMessages(watcherPool, fixtureConfig.databaseSchema)).find(row => row.message_id === nextMessage.messageId);
        assert.equal(nextRow.status, "FINALIZING");
        for (let successor = 0n; successor < config.finalityBlockDepth; successor += 1n) {
          await publicClient.request({ method: "evm_mine" });
        }
        await indexer.catchUpOnce();
        const finalPass = await watcher.runFinalityPass();
        assert.equal(finalPass.headBlock, nextMessage.sourceBlockNumber + config.finalityBlockDepth);
        nextRow = (await readMessages(watcherPool, fixtureConfig.databaseSchema)).find(row => row.message_id === nextMessage.messageId);
        assert.equal(nextRow.status, "FINALIZED");
        assert.equal(nextRow.finalized_at_head, finalPass.headBlock.toString());
        assert.equal(recoveryCalls, 0);
        console.log("VALID: deferred H+1 occurrence reached FINALIZING then FINALIZED on later fixed snapshots");
      } finally {
        resume.resolve();
        if (pending) await pending.catch(() => {});
      }
    }
    console.log("VALID: source snapshot concurrency regression passed for both deterministic real Chain A / independent PostgreSQL client interleavings");
  } finally {
    try {
      await Promise.all([watcherPool.end(), indexerPool.end()]);
    } finally {
      const restored = await publicClient.request({ method: "evm_revert", params: [chainSnapshot] });
      assert.equal(restored, true, "source concurrency fixture must restore its owned Chain A snapshot");
    }
  }
}
