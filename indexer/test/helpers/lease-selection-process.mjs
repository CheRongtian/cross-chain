// Fresh Relayer or transaction observation process using real PostgreSQL and an in-process destination
// RPC fixture. No network endpoint or second integration universe is created.
import { createDatabasePool,tableName } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { createRelayerWorker } from "../../src/relayer/service.mjs";
import { safeRelayerMessage } from "../../src/relayer/config.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { destinationRpcFixture,rpcExecutionRevert,transactionBody } from "./destination-rpc-fixtures.mjs";
import { transactionConfig } from "./transaction-fixtures.mjs";
import { fixtureHash } from "./delivery-fixtures.mjs";

const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: process.env.INDEXER_DB_SCHEMA,RELAYER_MAX_JOBS_PER_RUN: "1" });
const mode = process.argv[2] ?? "relayer";
const scanKind = ["receipt","receipt-selected"].includes(mode) ? "receipt" : ["recovery","recovery-selected"].includes(mode) ? "recovery" : null;
const pool = createDatabasePool(config);
try {
  const queue = createDeliveryRepository({ config,pool });
  let manager;
  const destination = destinationRpcFixture({ config,async onBroadcast(raw) {
    const row = (await pool.query(`SELECT delivery_job_id,attempt_id FROM ${tableName(config.databaseSchema,"transaction_attempts")}
      WHERE raw_signed_transaction = $1`,[raw])).rows[0];
    if (!row) throw new Error("fresh-process send requires durably visible signed bytes");
    const stored = await manager.repository.getTransaction(row.delivery_job_id);
    return transactionBody(stored.intent,stored.attempts.find(attempt => attempt.attemptId === row.attempt_id));
  } });
  manager = createTransactionManager({ config,pool,queue,rpc: destination.rpc,hooks: {
    afterObservationSelected: async ({ kind,ids }) => {
      if (kind === scanKind && mode.endsWith("-selected")) {
        // Deterministic crash boundary: the cursor commit is durable, but no
        // receipt/recovery RPC has begun. Exit code 73 is asserted by the parent.
        process.stdout.write(JSON.stringify({ kind,selectedIds: ids,interrupted: true }) + "\n",() => process.exit(73));
        await new Promise(() => {});
      }
    },
  } });
  if (scanKind) {
    const receiptIds = new Set(JSON.parse(process.env.OBSERVATION_RECEIPT_JOB_IDS ?? "[]"));
    for (const id of JSON.parse(process.env.OBSERVATION_JOB_IDS ?? "[]")) {
      const stored = await manager.repository.getTransaction(id); const attempt = stored.winningAttempt ?? stored.attempt;
      const blockHash = fixtureHash(1100);
      destination.transactions.set(attempt.transactionHash,transactionBody(stored.intent,attempt,100n,blockHash));
      if (receiptIds.has(id)) destination.receipts.set(attempt.transactionHash,{ transactionHash: attempt.transactionHash,
        blockNumber: "0x64",blockHash,status: "0x1" });
      for (const node of destination.nodes) {
        node.head = 102n;
        if (BigInt(stored.intent.nonce) >= node.latestNonce) node.latestNonce = BigInt(stored.intent.nonce) + 1n;
        node.pendingNonce = node.latestNonce;
      }
    }
    const result = scanKind === "receipt" ? await manager.checkReceiptsOnce({ limit: 1 }) : await manager.recoverTransactionsOnce({ limit: 1 });
    console.log(JSON.stringify({ scanned: result.checked ?? result.scanned,finalized: result.confirmed ?? result.finalized,
      ids: result.results.map(item => item.intent?.deliveryJobId ?? item.deliveryJobId) }));
  } else {
    const rejected = JSON.parse(process.env.PREPARATION_REJECT_JOB_IDS ?? "[]");
    const calldata = new Set(await Promise.all(rejected.map(async id => (await manager.resolveIntent(id)).calldata)));
    destination.nodes.forEach(node => node.faults.set("eth_estimateGas",({ params,forward }) => {
      if (calldata.has(params[0].data)) throw rpcExecutionRevert();
      return forward();
    }));
    const result = await createRelayerWorker({ config,pool,queue,transactionManager: manager }).runOnce();
    console.log(JSON.stringify(result.results.map(item => ({ deliveryJobId: item.intent?.deliveryJobId ?? item.deliveryJobId,
      submitted: item.submitted,action: item.action,reason: item.reason,retryAt: item.retryAt }))));
  }
} catch (error) {
  console.error(safeRelayerMessage(error,config)); process.exitCode = 1;
} finally { await pool.end(); }
