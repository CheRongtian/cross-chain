// Fresh Relayer process using real PostgreSQL and an in-process destination
// RPC fixture. No network endpoint or second integration universe is created.
import { createDatabasePool,tableName } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { createRelayerWorker } from "../../src/relayer/service.mjs";
import { safeRelayerMessage } from "../../src/relayer/config.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { destinationRpcFixture,rpcExecutionRevert,transactionBody } from "./destination-rpc-fixtures.mjs";
import { transactionConfig } from "./transaction-fixtures.mjs";

const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: process.env.INDEXER_DB_SCHEMA,RELAYER_MAX_JOBS_PER_RUN: "1" });
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
  manager = createTransactionManager({ config,pool,queue,rpc: destination.rpc });
  const rejected = JSON.parse(process.env.PREPARATION_REJECT_JOB_IDS ?? "[]");
  const calldata = new Set(await Promise.all(rejected.map(async id => (await manager.resolveIntent(id)).calldata)));
  destination.nodes.forEach(node => node.faults.set("eth_estimateGas",({ params,forward }) => {
    if (calldata.has(params[0].data)) throw rpcExecutionRevert();
    return forward();
  }));
  const result = await createRelayerWorker({ config,pool,queue,transactionManager: manager }).runOnce();
  console.log(JSON.stringify(result.results.map(item => ({ deliveryJobId: item.intent?.deliveryJobId ?? item.deliveryJobId,
    submitted: item.submitted,action: item.action,reason: item.reason,retryAt: item.retryAt }))));
} catch (error) {
  console.error(safeRelayerMessage(error,config)); process.exitCode = 1;
} finally { await pool.end(); }
