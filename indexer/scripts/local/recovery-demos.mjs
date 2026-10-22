import assert from "node:assert/strict";
import { readCursor,readIndexedSourceBlocks,tableName } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { encodeGatewaySubmission } from "../../src/relayer/encoding.mjs";
import { artifact,clients } from "./deployment.mjs";
import { produceLocalSourceMessage,runLocalDemo } from "./demo.mjs";
import { historyReader,runFaultDemo } from "./pbft-faults.mjs";
import { inspectLocalPrivacy } from "./privacy.mjs";
import { countDeliveryBroadcastEvents,readSourceTransactionCounts } from "./recovery-evidence.mjs";
import { httpJson,jsonText,safeError,waitFor,writeJson } from "./tools.mjs";
import { join } from "node:path";

export const RECOVERY_SCENARIOS = Object.freeze(["relayer-failover","source-reorg","replay-attack","recovery"]);

export function assertTransactionIdentity(actual,original) {
  assert.equal(actual.intents.length,1); assert.equal(actual.attempts.length,1);
  assert.equal(actual.accounts.length,1);
  for (const field of ["delivery_job_id","package_digest","chain_id","sender_address","destination_gateway","value","calldata","nonce","created_at"]) {
    assert.deepEqual(actual.intents[0][field],original.intents[0][field],`durable intent ${field} changed`);
  }
  for (const field of ["attempt_id","delivery_job_id","attempt_number","replacement_of_attempt_id","chain_id","sender_address","nonce","gas_limit","max_fee_per_gas","max_priority_fee_per_gas","transaction_type","transaction_hash","created_at"]) {
    assert.deepEqual(actual.attempts[0][field],original.attempts[0][field],`durable attempt ${field} changed`);
  }
  // Never let an assertion's diagnostic diff print raw signed bytes.
  assert.ok(actual.attempts[0].raw_signed_transaction === original.attempts[0].raw_signed_transaction,"durable signed bytes changed");
  assert.deepEqual(actual.accounts,original.accounts,"transaction nonce allocation changed");
}

export function assertHigherFence(before,after) {
  assert.equal(before.deliveryJobId,after.deliveryJobId);
  assert.notEqual(before.ownerSessionId,after.ownerSessionId);
  assert.notEqual(before.ownerId,after.ownerId);
  assert.ok(BigInt(after.fencingToken) > BigInt(before.fencingToken));
}

export function metricTotal(text,name) {
  return text.split("\n").filter(line => line.startsWith(name + "{") || line.startsWith(name + " "))
    .reduce((total,line) => total + Number(line.trim().split(/\s+/).at(-1)),0);
}

async function observeMetric(config,indices,name) {
  let total = 0;
  for (const index of indices) {
    const response = await fetch(`http://127.0.0.1:${config.ports.metrics[index]}/metrics`,{ signal: AbortSignal.timeout(10000) });
    assert.equal(response.ok,true); total += metricTotal(await response.text(),name);
  }
  assert.ok(Number.isFinite(total)); return total;
}

function context(options) {
  const { config,pool,alive } = options;
  const t = name => tableName(config.schema,name);
  return { t,wait: (label,operation,timeout = 120000) => waitFor(label,operation,{ alive,timeout,retryErrors: false }),
    async transaction(id) {
      const intents = (await pool.query(`SELECT * FROM ${t("transaction_intents")} WHERE delivery_job_id = $1`,[id])).rows;
      const accounts = intents.length ? (await pool.query(`SELECT chain_id,sender_address,next_nonce FROM ${t("transaction_accounts")}
        WHERE chain_id = $1 AND sender_address = $2`,[intents[0].chain_id,intents[0].sender_address])).rows : [];
      return { intents,accounts,attempts: (await pool.query(`SELECT * FROM ${t("transaction_attempts")} WHERE delivery_job_id = $1 ORDER BY attempt_id`,[id])).rows };
    },
    async counts(result) {
      for (const [address,name,eventName] of [[config.deployments.destinationGateway,"DestinationGateway","CrossChainMessageExecuted"],
        [config.deployments.applicationB,"ApplicationB","VerifiedSupplierGranted"]]) {
        assert.equal((await clients(config.chainB,2001).publicClient.getContractEvents({ address,abi: (await artifact(name)).abi,eventName,
          args: { messageId: result.messageId },fromBlock: 0n,toBlock: "latest",strict: true })).length,1);
      }
    },
  };
}

async function transportDemo(options) {
  const { config,pool,scenario,relayers,paths,progress,processes,pipeline } = options;
  const { t,wait,transaction,counts } = context(options);
  const combined = scenario === "recovery";
  const replay = scenario === "replay-attack";
  const roles = ["relayer-a","relayer-b"];
  let id; let original; let owner; let takeover; let restoreValidator; let duplicate; let authentic;
  let failure;
  const a = () => relayers.at(roles[0]);
  const control = (role,operation,argument) => relayers.at(role).rpc(operation,argument);
  const sends = () => paths.flatMap(path => path.calls.filter(call => call.method === "eth_sendRawTransaction"));
  const sendCount = sends().length;
  async function blocked(role) {
    return wait(role + " durable SIGNED barrier",async () => {
      const status = await control(role,"status");
      return status.blocked?.id === id && status.blocked.name === "signed-persisted" ? status : false;
    });
  }
  async function unchanged() {
    assertTransactionIdentity(await transaction(id),original);
    assert.equal((await pool.query(`SELECT status FROM ${t("delivery_jobs")} WHERE delivery_job_id = $1`,[id])).rows[0].status,"READY");
  }
  async function finishWorkers({ stopReplay = true } = {}) {
    for (const role of roles) { await relayers.restore(role); await control(role,"clear"); }
    if (stopReplay) await relayers.stopReplay();
    await relayers.healthy();
  }
  try {
    for (const role of roles) await control(role,"pause");
    const initialA = (await control(roles[0],"status")).counts;
    const hooks = {
      async afterReady({ pack,job,deliveryConfig }) {
        id = job.delivery_job_id;
        const queue = createDeliveryRepository({ config: deliveryConfig,pool });
        authentic = { pack,queue,deliveryConfig,encoded: await encodeGatewaySubmission(pack,{ validatorSets: deliveryConfig.validatorSets }) };
        assert.equal((await transaction(id)).intents.length,0);
        if (replay) duplicate = await relayers.startReplay();
        await control(roles[0],"arm",{ id }); await control(roles[0],"resume");
        const signed = await blocked(roles[0]); owner = signed.blocked;
        original = await transaction(id);
        assert.equal(original.intents.length,1); assert.equal(original.attempts.length,1);
        assert.equal(original.intents[0].status,"PENDING"); assert.equal(owner.created,true);
        assert.equal(original.attempts[0].status,"SIGNED"); assert.equal(original.attempts[0].broadcast_at,null);
        assert.equal(original.attempts[0].attempt_number,0); assert.equal(original.attempts[0].broadcast_attempt_count,"0");
        assert.equal(original.attempts[0].transaction_hash,owner.transactionHash);
        assert.equal(original.attempts[0].attempt_id,owner.attemptId); assert.equal(original.intents[0].nonce,owner.nonce);
        const destination = clients(config.chainB,2001).publicClient;
        assert.equal(await destination.request({ method: "eth_getTransactionByHash",params: [owner.transactionHash] }),null);
        assert.equal(await destination.request({ method: "eth_getTransactionReceipt",params: [owner.transactionHash] }),null);
        assert.equal(owner.fence.ownerId,roles[0]); assert.equal(sends().length,sendCount);
        for (const field of ["signatures","estimates","feeQuotes"]) assert.equal(signed.counts[field],initialA[field] + 1);
        const authority = (await pool.query(`SELECT
          (SELECT COUNT(*) FROM ${t("source_messages")} WHERE message_id = $1)::int AS sources,
          (SELECT COUNT(*) FROM ${t("message_batch_members")} WHERE message_id = $1)::int AS members,
          (SELECT COUNT(*) FROM ${t("batch_quorum_certificates")} WHERE batch_id = $2)::int AS qcs,
          (SELECT COUNT(*) FROM ${t("delivery_jobs")} WHERE message_id = $1)::int AS jobs`,[pack.message.messageId,pack.batchId])).rows[0];
        assert.deepEqual(authority,{ sources: 1,members: 1,qcs: 1,jobs: 1 });
        const lease = (await pool.query(`SELECT * FROM ${t("relayer_job_leases")} WHERE delivery_job_id = $1`,[id])).rows[0];
        assert.equal(lease.owner_id,signed.workerId); assert.equal(lease.fencing_token,owner.fence.fencingToken);
        assert.equal(signed.pid,a().record.pid);
        progress(`VALID: target ${pack.message.messageId}; READY job ${id}; current owner ${signed.workerId} pid=${signed.pid}, fence=${lease.fencing_token}; durable intent/nonce=${original.intents[0].nonce}, signed hash=${owner.transactionHash}; external sends=0`);
        if (replay) {
          const prepared = await duplicate.rpc("prepareReplay",{ id });
          assert.notEqual(prepared.sender,original.intents[0].sender_address);
          assert.equal(prepared.calldata,authentic.encoded.calldata);
          duplicate.prepared = prepared;
          await control(roles[0],"resume");
          return;
        }
        await control(roles[1],"arm",{ id });
        const beforeB = (await control(roles[1],"status")).counts;
        assert.equal(await relayers.crash(lease.owner_id),signed.pid);
        const deadLease = (await pool.query(`SELECT *,clock_timestamp() AS observed_at FROM ${t("relayer_job_leases")} WHERE delivery_job_id = $1`,[id])).rows[0];
        assert.equal(deadLease.owner_id,roles[0]); assert.equal(deadLease.released_at,null);
        assert.ok(deadLease.lease_expires_at > deadLease.observed_at,"owner must die before lease expiry");
        await control(roles[1],"resume");
        await wait("natural database-time lease expiry",async () =>
          (await pool.query("SELECT clock_timestamp() >= $1::timestamptz AS expired",[deadLease.lease_expires_at])).rows[0].expired);
        const reused = await blocked(roles[1]); takeover = reused.blocked;
        assertHigherFence(owner.fence,takeover.fence);
        assert.ok(new Date(takeover.fence.leaseAcquiredAt) >= deadLease.lease_expires_at);
        assert.equal(takeover.created,false); assert.equal(takeover.transactionHash,owner.transactionHash);
        for (const field of ["signatures","estimates","feeQuotes"]) assert.equal(reused.counts[field],beforeB[field]);
        await unchanged(); assert.equal(sends().length,sendCount);
        progress(`VALID: actual owner ${roles[0]} terminated after committed SIGNED; PostgreSQL lease expired naturally; ${roles[1]} pid=${reused.pid} acquired higher fence ${takeover.fence.fencingToken}; same intent/nonce/attempt/bytes/hash, no re-signing`);
        // Restart the old identity while B holds a renewed lease, then keep A
        // paused so it cannot become an extra recovery owner for this target.
        await relayers.restore(roles[0]); await control(roles[0],"pause");
        const beforeProbe = await transaction(id);
        const stale = await control(roles[0],"assertStale",{ id,fence: owner.fence });
        assert.equal(stale.rejected,"STALE_FENCE");
        assertTransactionIdentity(await transaction(id),beforeProbe);
        assert.equal(await countDeliveryBroadcastEvents(pool,config.schema,id),0);
        progress("EXPECTED FAILURE: restarted former owner cannot prepare, mutate or continue a send under its captured stale fence");
        if (combined) {
          assert.equal(paths.length,2);
          const rpcFailures = await observeMetric(config,[4],"cross_chain_rpc_failures_total");
          for (const path of paths) path.state.available = false;
          const errorCount = (await control(roles[1],"status")).errors.length;
          await control(roles[1],"resume");
          const outage = await wait("structured all-path RPC_UNAVAILABLE",async () => {
            const status = await control(roles[1],"status");
            return status.errors.slice(errorCount).find(error => error.code === "RPC_UNAVAILABLE" &&
              new Set(error.observations.filter(value => value.outcome === "UNAVAILABLE" && value.errorClass === "TRANSIENT_RPC_ERROR").map(value => value.endpointLabel)).size === paths.length);
          });
          assert.equal(outage.code,"RPC_UNAVAILABLE");
          assert.ok(await observeMetric(config,[4],"cross_chain_rpc_failures_total") > rpcFailures,"live standby RPC failure metric must observe the injected outage");
          await unchanged(); assert.equal(sends().length,sendCount);
          const during = (await control(roles[1],"status")).counts;
          for (const field of ["signatures","estimates","feeQuotes"]) assert.equal(during[field],beforeB[field]);
          assert.equal(await clients(config.chainB,2001).publicClient.getChainId(),2001);
          assert.equal((await clients(config.chainB,2001).publicClient.getBlock({ blockNumber: 0n })).hash,config.genesisHash);
          progress("EXPECTED FAILURE: both configured destination RPC paths returned structured RPC_UNAVAILABLE; Chain B remains alive; durable READY/intent/nonce/signed identity intact, no new signature or external send");
          assert.equal(typeof restoreValidator,"function"); await restoreValidator();
          for (const path of paths) {
            path.state.available = true;
            const identity = await httpJson(path.url,{ jsonrpc: "2.0",id: 1,method: "eth_chainId",params: [] });
            assert.equal(BigInt(identity.result),2001n);
            const genesis = await httpJson(path.url,{ jsonrpc: "2.0",id: 2,method: "eth_getBlockByNumber",params: ["0x0",false] });
            assert.equal(genesis.result.hash,config.genesisHash);
          }
          progress("VALID: same validator identity/store restarted without historical votes; same Chain B RPC endpoints restored; ordinary leased worker polling resumes without SQL reset or force-submit");
        } else await control(roles[1],"resume");
      },
      async afterConfirmed() { await finishWorkers({ stopReplay: false }); },
    };
    const result = combined ? await runFaultDemo({ ...options,...hooks,scenario: "validator-crash",pipeline,processes,
      afterConsensus({ restore }) { restoreValidator = restore; } }) : await runLocalDemo({ ...options,...hooks });
    await unchanged();
    const final = await transaction(id);
    assert.equal(final.intents[0].status,"CONFIRMED"); assert.equal(final.attempts[0].status,"CONFIRMED");
    assert.equal(final.intents[0].winning_attempt_id,original.attempts[0].attempt_id);
    assert.equal(final.attempts[0].transaction_hash,result.destinationTransaction);
    if (replay) {
      const preserved = await historyReader(config,pool); const before = await preserved();
      const sent = await duplicate.rpc("sendReplay");
      const client = clients(config.chainB,2001).publicClient;
      const receipt = await client.waitForTransactionReceipt({ hash: sent.transactionHash,timeout: 30000 });
      assert.equal(receipt.status,"reverted"); assert.equal(receipt.logs.length,0);
      const transaction = await client.getTransaction({ hash: receipt.transactionHash });
      assert.equal(transaction.input,authentic.encoded.calldata); assert.equal(transaction.from.toLowerCase(),duplicate.prepared.sender);
      assert.notEqual(transaction.from.toLowerCase(),original.intents[0].sender_address);
      await assert.rejects(client.simulateContract({ address: config.deployments.destinationGateway,abi: (await artifact("DestinationGateway")).abi,
        functionName: "execute",args: [authentic.encoded.data],account: transaction.from,gas: transaction.gas,blockNumber: receipt.blockNumber }),error => {
        for (let cause = error; cause; cause = cause.cause) if (cause.data?.errorName === "MessageAlreadyExecuted") {
          assert.deepEqual(cause.data.args,[result.messageId]); return true;
        }
        return false;
      });
      assert.ok(jsonText(await preserved()) === jsonText(before),"replay changed protected source/batch/QC/transaction history");
      assert.equal((await client.getBlock({ blockNumber: receipt.blockNumber })).hash,receipt.blockHash);
      assert.equal((await client.getTransactionReceipt({ hash: result.destinationTransaction })).blockHash,result.destinationBlockHash);
      const gatewayAbi = (await artifact("DestinationGateway")).abi; const appAbi = (await artifact("ApplicationB")).abi;
      assert.equal(await client.readContract({ address: config.deployments.destinationGateway,abi: gatewayAbi,functionName: "isMessageExecuted",args: [result.messageId] }),true);
      assert.equal(await client.readContract({ address: config.deployments.applicationB,abi: appAbi,functionName: "isVerifiedSupplier",args: [result.supplier] }),true);
      progress(`EXPECTED FAILURE: a different sender's authentic byte-identical delivery actually reached production Gateway and reverted with MessageAlreadyExecuted(${result.messageId}); canonical failed transaction ${receipt.transactionHash}`);
      result.replay = { transactionHash: receipt.transactionHash,sender: transaction.from,error: "MessageAlreadyExecuted" };
    }
    await counts(result);
    assert.equal(sends().length - sendCount,replay ? 2 : 1,"unexpected additional external raw transaction send");
    const encodedNow = await encodeGatewaySubmission(await authentic.queue.getDeliveryPackage(id),{ validatorSets: authentic.deliveryConfig.validatorSets });
    assert.equal(encodedNow.calldata,authentic.encoded.calldata);
    progress("VALID: one canonical transaction winner, one Gateway execution and one ApplicationB grant; authentic package, source evidence and signed transaction identity preserved");
    return { ...result,recovery: { scenario,originalOwner: owner.fence.ownerId,originalFence: owner.fence.fencingToken,
      takeoverOwner: takeover?.fence.ownerId ?? null,takeoverFence: takeover?.fence.fencingToken ?? null,
      transactionHash: original.attempts[0].transaction_hash,nonce: original.intents[0].nonce,externalSends: sends().length - sendCount } };
  } catch (error) { failure = error; throw error; }
  finally {
    for (const path of paths) path.state.available = true;
    if (failure) { processes.fail(failure); await relayers.stopReplay(); }
    else await finishWorkers();
  }
}

async function sourceReorgDemo(options) {
  const { config,pool,progress } = options;
  const { t,wait,counts } = context(options);
  const chain = clients(config.chainA,10011).publicClient;
  const b = clients(config.chainB,2001).publicClient;
  const sourceAbi = (await artifact("SourceGateway")).abi;
  const nonce = await chain.readContract({ address: config.deployments.sourceGateway,abi: sourceAbi,functionName: "nextNonce" });
  const supplier = offset => "0x" + (0x300000n + nonce * 2n + offset).toString(16).padStart(40,"0");
  const scope = { chainDomain: 10011n,sourceGateway: config.deployments.sourceGateway };
  const reorgsBefore = await observeMetric(config,[0,1],"cross_chain_messages_reorged_total");
  const readAccounts = async () => (await pool.query(`SELECT chain_id,sender_address,next_nonce FROM ${t("transaction_accounts")} ORDER BY chain_id,sender_address`)).rows;
  const accountsBefore = await readAccounts();
  let snapshot; let ancestor; let reverted = false;
  try {
    const orphan = await produceLocalSourceMessage({ ...options,supplier: supplier(0n),
      async beforeSourceBroadcast() { ancestor = await chain.getBlock(); snapshot = await chain.request({ method: "evm_snapshot" }); } });
    const row = await wait("source FINALIZING before fork",async () => {
      const value = await orphan.readSource(); assert.notEqual(value.status,"FINALIZED"); return value.status === "FINALIZING" ? value : false;
    });
    assert.equal(row.finalized_at,null); assert.equal(orphan.sourceReceipt.blockNumber,ancestor.number + 1n);
    async function excluded() {
      for (const name of ["message_batch_members","delivery_jobs"]) {
        assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${t(name)} WHERE source_message_id = $1 OR message_id = $2`,[row.id,orphan.message.messageId])).rows[0].count,0);
      }
      const propagated = (await pool.query(`SELECT COUNT(*)::int AS count FROM ${t("batch_quorum_certificates")} q
        JOIN ${t("message_batch_members")} m USING (batch_record_id) WHERE m.source_message_id = $1 OR m.message_id = $2`,[row.id,orphan.message.messageId])).rows[0].count;
      assert.equal(propagated,0);
      assert.deepEqual(await readSourceTransactionCounts(pool,config.schema,{
        sourceMessageId: row.id,messageId: orphan.message.messageId,
      }),{ intents: 0,attempts: 0,broadcasts: 0 });
      assert.equal(await b.readContract({ address: config.deployments.destinationGateway,abi: orphan.destinationAbi,functionName: "isMessageExecuted",args: [orphan.message.messageId] }),false);
      assert.equal(await b.readContract({ address: config.deployments.applicationB,abi: orphan.applicationBAbi,functionName: "isVerifiedSupplier",args: [orphan.supplier] }),false);
      for (const [address,abi,eventName] of [[config.deployments.destinationGateway,orphan.destinationAbi,"CrossChainMessageExecuted"],
        [config.deployments.applicationB,orphan.applicationBAbi,"VerifiedSupplierGranted"]]) {
        assert.equal((await b.getContractEvents({ address,abi,eventName,args: { messageId: orphan.message.messageId },fromBlock: 0n,toBlock: "latest",strict: true })).length,0);
      }
    }
    await excluded();
    progress(`VALID: fresh authorized occurrence ${orphan.message.messageId} is FINALIZING, never FINALIZED, with zero downstream authority`);
    assert.equal(await chain.request({ method: "evm_revert",params: [snapshot] }),true); reverted = true;
    assert.equal((await chain.getBlock()).hash,ancestor.hash);
    assert.equal(await chain.readContract({ address: config.deployments.sourceGateway,abi: sourceAbi,functionName: "nextNonce" }),orphan.message.nonce);
    const authorizationAbi = (await artifact("IdentityApplicationA")).abi;
    const orphanNullifier = BigInt(orphan.prepared.publicInputs.nullifier);
    assert.equal(await chain.readContract({ address: config.deployments.identityApplication,abi: authorizationAbi,functionName: "usedNullifiers",args: [orphanNullifier] }),false);
    await chain.request({ method: "anvil_mine",params: ["0x1"] });
    assert.notEqual((await chain.getBlock({ blockNumber: orphan.sourceReceipt.blockNumber })).hash,orphan.sourceReceipt.blockHash);
    assert.equal(await chain.request({ method: "eth_getTransactionReceipt",params: [orphan.hash] }),null);
    const removed = await wait("production reconciliation preserves terminal orphan",async () => {
      const value = await orphan.readSource(); return value.status === "REORGED" ? value : false;
    });
    assert.ok(removed.reorged_at); assert.equal(removed.source_block_hash,orphan.sourceReceipt.blockHash);
    assert.equal(removed.source_tx_hash,orphan.hash); assert.equal(removed.finalized_at,null);
    await wait("rewound cursor and replacement canonical block metadata",async () => {
      const cursor = await readCursor(pool,config.schema,scope);
      const blocks = await readIndexedSourceBlocks(pool,config.schema,scope);
      const current = blocks.find(block => BigInt(block.block_number) === orphan.sourceReceipt.blockNumber);
      if (!current || !cursor || BigInt(cursor.next_block) <= orphan.sourceReceipt.blockNumber) return false;
      assert.notEqual(current.block_hash,orphan.sourceReceipt.blockHash);
      assert.equal(current.block_hash,(await chain.getBlock({ blockNumber: orphan.sourceReceipt.blockNumber })).hash);
      return true;
    });
    await wait("live source reorg metric after durable reconciliation",async () => {
      const total = await observeMetric(config,[0,1],"cross_chain_messages_reorged_total");
      assert.ok(total <= reorgsBefore + 1,"one orphan was counted more than once");
      return total === reorgsBefore + 1;
    });
    await excluded();
    const observed = await httpJson(config.api + "/api/v1/messages/" + orphan.message.messageId);
    assert.equal(observed.finality.status,"REORGED"); assert.equal(observed.batch,null); assert.equal(observed.qc,null);
    assert.equal(observed.delivery,null); assert.equal(observed.destinationTransaction,null);
    await inspectLocalPrivacy({ config,messageId: orphan.message.messageId,privateCredential: orphan.privateCredential,
      destination: { calldata: "0x",logs: [],state: { messageExecuted: false,supplierVerified: false } },progress,expectedStatus: "REORGED" });
    assert.deepEqual(await readAccounts(),accountsBefore,"orphan reconciliation must not allocate a destination nonce");
    const replacement = await runLocalDemo({ ...options,supplier: supplier(1n) });
    assert.notEqual(replacement.messageId,orphan.message.messageId); assert.notEqual(replacement.supplier,orphan.supplier);
    assert.equal(await chain.readContract({ address: config.deployments.identityApplication,abi: authorizationAbi,functionName: "usedNullifiers",args: [orphanNullifier] }),false);
    await excluded(); await counts(replacement);
    progress("VALID: real Chain A branch replacement was reconciled by the live Indexer/Watcher; exact orphan retained as REORGED with no batch/QC/READY/intent/nonce/signature/destination effect; fresh canonical replacement completed end-to-end");
    const evidence = { messageId: orphan.message.messageId,sourceTransaction: orphan.hash,sourceBlockHash: orphan.sourceReceipt.blockHash,
      supplier: orphan.supplier,status: "REORGED",explorer: config.api + "/?messageId=" + orphan.message.messageId };
    await writeJson(join(config.directory,`demo-${evidence.messageId}.json`),evidence);
    return { ...replacement,reorg: evidence };
  } finally {
    // A successful revert consumes its snapshot. An unused checkpoint is never
    // used to rewind finalized replacement/history during failure cleanup.
    if (snapshot && !reverted) progress("Source reorg checkpoint left unused; canonical history was not rewound during cleanup");
  }
}

export async function runRecoveryDemo(options) {
  assert.equal(options.config.isolated,true);
  assert.ok(RECOVERY_SCENARIOS.includes(options.scenario));
  const readHistory = await historyReader(options.config,options.pool); const before = await readHistory();
  options.progress(`${options.scenario.toUpperCase().replaceAll("-"," ")} DEMO:`);
  try {
    const result = options.scenario === "source-reorg" ? await sourceReorgDemo(options) : await transportDemo(options);
    assert.ok(jsonText(await readHistory()) === jsonText(before),"historical message/batch/QC/delivery/signed-transaction evidence changed");
    options.alive(); await options.relayers.healthy();
    for (const path of options.paths) { assert.equal(path.state.available,true); assert.equal(path.errors.length,0); }
    return result;
  } catch (error) {
    options.progress("Recovery demonstration failed: " + safeError(error)); options.processes.fail(error); throw error;
  }
}
