import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";
import { createRelayerWorker } from "../src/relayer/service.mjs";
import { memoryLeaseFixture } from "./helpers/lease-fixtures.mjs";
import { loadTransactionConfig, publicTransactionConfig } from "../src/transaction-manager/config.mjs";
import { allocateNonce } from "../src/transaction-manager/nonce-policy.mjs";
import { signDeliveryTransaction, verifySignedTransaction, unsignedTransaction, rpcQuantity } from "../src/transaction-manager/transaction.mjs";
import { transactionConfig, transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { relayerEnvironment } from "./helpers/relayer-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { DestinationRpcError } from "../src/transaction-manager/rpc-pool.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";

test("receipt limit=1 rotates through missing earlier receipts and confirms a later canonical transaction within N rounds", async () => {
  const h = await transactionHarness();
  for (const job of h.jobs) { await h.manager.submitDelivery(job.deliveryJobId); h.mine(job.deliveryJobId); }
  for (const job of h.jobs.slice(0,2)) h.state.receipts.delete(h.records.get(job.deliveryJobId).attempt.transactionHash);
  h.state.head = 102n;
  const inspect = h.rpc.receiptEvidence; let observed = 0;
  h.rpc.receiptEvidence = async (...args) => { observed++; return inspect(...args); };
  for (let round = 0; round < 3; round++) {
    const before = observed;
    const manager = createTransactionManager({ ...h.options,repository: { ...h.repository } });
    const result = await manager.checkReceiptsOnce({ limit: 1 });
    assert.equal(result.checked,1); assert.equal(observed - before,1);
    assert.equal(result.results[0].intent.deliveryJobId,h.jobs[round].deliveryJobId);
    assert.equal(result.confirmed,round === 2 ? 1 : 0);
  }
  assert.equal(h.records.get(h.jobs[0].deliveryJobId).intent.status,"PENDING");
  assert.equal(h.records.get(h.jobs[2].deliveryJobId).intent.status,"CONFIRMED");
  assert.equal(h.scanCursors.recovery,null); assert.equal(h.calls.broadcast.length,3); assert.equal(h.calls.sign,3);
});

test("independent observation selectors wrap uniquely, preserve exact large nonces and mutate no transaction or allocator evidence", async () => {
  const h = await transactionHarness();
  assert.deepEqual(await h.repository.listRecoveryIntents({ limit: 1 }),[]);
  assert.deepEqual(await h.repository.listTrackingIntents({ limit: 1 }),[]); assert.equal(await h.repository.getAccount(),null);
  h.state.pendingNonce = (1n << 200n) + 17n;
  for (const job of h.jobs) await h.manager.submitDelivery(job.deliveryJobId);
  const before = structuredClone([...h.records]); const versions = [...h.versions];
  const account = await h.repository.getAccount(); const activity = structuredClone(h.calls);
  const ids = h.jobs.map(job => job.deliveryJobId);
  const nonces = ids.map(id => h.records.get(id).intent.nonce);
  for (const kind of ["receipt","recovery"]) {
    const select = async limit => {
      const repository = { ...h.repository };
      return kind === "receipt" ? (await repository.listTrackingIntents({ limit })).map(record => record.intent.deliveryJobId) : repository.listRecoveryIntents({ limit });
    };
    assert.deepEqual(await select(1),[ids[0]]); assert.equal(h.scanCursors[kind],nonces[0]);
    assert.deepEqual(await select(1),[ids[1]]); assert.equal(h.scanCursors[kind],nonces[1]);
    assert.deepEqual(await select(100),[ids[2],ids[0],ids[1]]);
    h.scanCursors[kind] = ((1n << 256n) - 1n).toString();
    assert.deepEqual(await select(100),ids);
    for (const limit of [0,1001,1.5,"1"]) await assert.rejects(select(limit),{ code: "INVALID_DELIVERY_LIMIT" });
  }
  assert.deepEqual([...h.records],before); assert.deepEqual([...h.versions],versions);
  assert.deepEqual(await h.repository.getAccount(),account); assert.deepEqual(h.calls,activity);
});

test("receipt rotation handles terminal removal, new higher nonces, empty and single populations", async () => {
  const h = await transactionHarness({ count: 4 });
  const ids = h.jobs.map(job => job.deliveryJobId);
  for (const id of ids.slice(0,3)) await h.manager.submitDelivery(id);
  assert.equal((await h.repository.listTrackingIntents({ limit: 2 }))[1].intent.deliveryJobId,ids[1]);
  await h.manager.submitDelivery(ids[3]);
  assert.deepEqual((await h.repository.listTrackingIntents({ limit: 3 })).map(r => r.intent.deliveryJobId),[ids[2],ids[3],ids[0]]);
  for (const id of ids.slice(0,3)) {
    h.mine(id); h.state.head = 102n;
    const stored = await h.repository.getTransaction(id);
    await h.repository.recordOutcome(id,{ transactionHash: stored.attempt.transactionHash,status: 1,
      blockNumber: 100n,blockHash: fixtureHash(1100),head: 102n });
  }
  for (let round = 0; round < 3; round++) assert.deepEqual((await h.repository.listTrackingIntents({ limit: 100 })).map(r => r.intent.deliveryJobId),[ids[3]]);
  const stored = await h.repository.getTransaction(ids[3]);
  await h.repository.recordOutcome(ids[3],{ transactionHash: stored.attempt.transactionHash,status: 0,
    blockNumber: 100n,blockHash: fixtureHash(1100),head: 102n });
  const cursor = h.scanCursors.receipt;
  assert.deepEqual(await h.repository.listTrackingIntents({ limit: 1 }),[]); assert.equal(h.scanCursors.receipt,cursor);
});

test("a receipt selection interruption commits progress but wrap revisits the unobserved intent", async () => {
  let armed = true;
  const h = await transactionHarness({ hooks: { afterObservationSelected: async ({ kind }) => {
    if (kind === "receipt" && armed) { armed = false; throw Object.assign(new Error("selected receipt interruption"),{ code: "TEST_CHECKPOINT" }); }
  } } });
  for (const job of h.jobs) await h.manager.submitDelivery(job.deliveryJobId);
  await assert.rejects(h.manager.checkReceiptsOnce({ limit: 1 }),{ code: "TEST_CHECKPOINT" });
  assert.equal(h.calls.head,0,"selection interruption happens before RPC observation");
  const offered = [];
  for (let round = 0; round < 3; round++) offered.push((await h.restart().checkReceiptsOnce({ limit: 1 })).results[0].intent.deliveryJobId);
  assert.deepEqual(offered,[h.jobs[1].deliveryJobId,h.jobs[2].deliveryJobId,h.jobs[0].deliveryJobId]);
  assert.equal(h.scanCursors.recovery,null);
});

test("explicit per-job receipt inspection and recovery leave both automatic cursors unchanged", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id); h.state.head = 102n; h.advance(h.config.replacementAfterMs);
  const result = await h.manager.prepareReplacement(id);
  assert.equal(result.created,false); assert.equal(result.intent.status,"CONFIRMED");
  assert.deepEqual(h.scanCursors,{ receipt: null,recovery: null });
  await h.restart().recoverTransactionsOnce({ deliveryJobId: id });
  assert.deepEqual(h.scanCursors,{ receipt: null,recovery: null });
});

test("explicit estimate execution rejection precedes fees, pending nonce and all durable transaction side effects", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  h.rpc.estimateGas = async () => { h.calls.gas++; throw new DestinationRpcError("ESTIMATE_EXECUTION_REVERT",{ errorClass: "DETERMINISTIC_REJECTION" }); };
  await assert.rejects(h.manager.prepareDeliveryTransaction(id),{ code: "PREPARATION_EXECUTION_REJECTED" });
  assert.equal(h.records.size,0); assert.equal(h.journal.length,0); assert.equal(await h.repository.getAccount(),null);
  assert.equal(h.calls.gas,1); assert.equal(h.calls.fees,0); assert.equal(h.calls.pending,0);
  assert.equal(h.calls.sign,0); assert.equal(h.calls.broadcast.length,0); assert.deepEqual(h.packets,h.original);
});

test("the preparation signal is restricted to estimate and absent-intent boundaries", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  const first = await h.manager.prepareDeliveryTransaction(id);
  h.rpc.estimateGas = async () => { throw new Error("existing intent must bypass estimate"); };
  assert.deepEqual((await h.restart().prepareDeliveryTransaction(id)).attempt,first.attempt);
  const late = await transactionHarness();
  late.rpc.fees = async () => { throw new DestinationRpcError("ESTIMATE_EXECUTION_REVERT",{ errorClass: "DETERMINISTIC_REJECTION" }); };
  await assert.rejects(late.manager.prepareDeliveryTransaction(late.jobs[0].deliveryJobId),{ code: "ESTIMATE_EXECUTION_REVERT" });
  assert.equal(late.records.size,0); assert.equal(late.calls.sign,0);
});

test("confirmation configuration is exact, nonzero and private-key free in public output", () => {
  assert.equal(transactionConfig().destinationConfirmations,3n);
  assert.equal(transactionConfig({ DESTINATION_CONFIRMATIONS: (1n << 200n).toString() }).destinationConfirmations,1n << 200n);
  for (const value of ["0","-1","1.1","", "01"]) assert.throws(() => loadTransactionConfig(relayerEnvironment({ DESTINATION_CONFIRMATIONS: value })));
  const config = transactionConfig();
  const view = publicTransactionConfig(config);
  assert.equal(view.destinationConfirmations,"3"); assert.equal("privateKey" in view,false);
  assert.ok(!JSON.stringify(view).includes(config.privateKey));
});

test("nonce selection reconciles pending/local/reserved state with exact arithmetic", () => {
  assert.deepEqual(allocateNonce({ pendingNonce: 9n,nextNonce: 0n }),{ nonce: 9n,nextNonce: 10n });
  assert.equal(allocateNonce({ pendingNonce: 9n,nextNonce: 12n }).nonce,12n);
  assert.equal(allocateNonce({ pendingNonce: 15n,nextNonce: 12n }).nonce,15n);
  assert.equal(allocateNonce({ pendingNonce: 9n,nextNonce: 12n,highestReservedNonce: 15n }).nonce,16n);
  const large = (1n << 100n) + 1n;
  assert.equal(allocateNonce({ pendingNonce: large,nextNonce: 0n }).nextNonce,large + 1n);
  assert.throws(() => allocateNonce({ pendingNonce: (1n << 256n) - 1n,nextNonce: 0n }),{ code: "NONCE_SPACE_EXHAUSTED" });
  assert.equal(rpcQuantity("0x20000000000001"),9007199254740993n);
  for (const value of [9,"9","0x", "0x00"]) assert.throws(() => rpcQuantity(value));
});

test("local type-2 signing preserves exact fields and is deterministic even with a large nonce", async () => {
  const h = await transactionHarness();
  const intent = await h.manager.resolveIntent(h.jobs[0].deliveryJobId);
  const fields = { nonce: (1n << 100n) + 1n,gasLimit: 123456n,maxFeePerGas: 3000000000n,maxPriorityFeePerGas: 1000000000n };
  const account = privateKeyToAccount(h.config.privateKey);
  const a = await signDeliveryTransaction(intent,fields,account);
  const b = await signDeliveryTransaction(intent,fields,account);
  assert.deepEqual(a,b); assert.equal(a.transactionHash,keccak256(a.rawSignedTransaction));
  assert.ok(a.rawSignedTransaction.startsWith("0x02"));
  assert.equal(unsignedTransaction(intent,fields).nonce,fields.nonce);
  assert.equal(unsignedTransaction(intent,fields).chainId,h.config.destinationDomain);
  assert.equal(unsignedTransaction(intent,fields).to,h.packets[0].message.destinationGateway);
  assert.equal(unsignedTransaction(intent,fields).value,0n);
  await verifySignedTransaction(intent,a);
  await assert.rejects(verifySignedTransaction(intent,{ ...a,nonce: fields.nonce + 1n }),{ code: "CORRUPTED_SIGNED_TRANSACTION" });
  const tampered = `${a.rawSignedTransaction.slice(0,-2)}${a.rawSignedTransaction.endsWith("00") ? "01" : "00"}`;
  await assert.rejects(verifySignedTransaction(intent,{ ...a,rawSignedTransaction: tampered,transactionHash: keccak256(tampered) }));
  await assert.rejects(verifySignedTransaction({ ...intent,destinationGateway: h.packets[0].message.destinationReceiver },a));
});

test("same delivery intent recovers exact SIGNED state without estimating, signing or reserving again", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  const first = await h.manager.prepareDeliveryTransaction(id);
  assert.equal(first.attempt.status,"SIGNED"); assert.equal(first.attempt.nonce,"9");
  assert.equal(h.calls.broadcast.length,0);
  const recovered = await h.restart().prepareDeliveryTransaction(id);
  assert.deepEqual(recovered.attempt,first.attempt); assert.deepEqual(recovered.intent,first.intent);
  assert.equal(recovered.created,false); assert.equal(h.calls.gas,1); assert.equal(h.calls.fees,1); assert.equal(h.calls.sign,1);
  assert.equal(h.records.size,1); assert.equal((await h.repository.getAccount()).nextNonce,"10");
  assert.ok(!JSON.stringify(first).includes(h.config.privateKey));
  const second = await h.manager.prepareDeliveryTransaction(h.jobs[1].deliveryJobId);
  assert.notEqual(second.intent.intentId,first.intent.intentId); assert.equal(second.attempt.nonce,"10");
  h.records.get(id).intent.packageDigest = fixtureHash(99);
  await assert.rejects(h.restart().prepareDeliveryTransaction(id),{ code: "CONFLICTING_TRANSACTION_INTENT" });
});

test("corrupt packages and wrong destination RPC allocate no nonce and produce no signed transaction", async () => {
  for (const mutate of [p => { p.message.payload = "0xffff"; },p => { p.message.messageId = fixtureHash(99); },
    p => { p.messageRoot = fixtureHash(99); },p => { p.merkleProof.siblings[0] = fixtureHash(99); },
    p => { p.quorumCertificate.commits[0].signature = `0x${"ff".repeat(65)}`; },p => { p.validatorEpoch = "99"; },
    p => { p.batchId = fixtureHash(99); },p => { p.message.destinationDomain = "3001"; },p => { p.committeeDigest = fixtureHash(99); },
    p => { p.message.destinationGateway = p.message.destinationReceiver; }]) {
    const h = await transactionHarness({ mutate });
    await assert.rejects(h.manager.submitDelivery(h.jobs[0].deliveryJobId));
    assert.equal(h.records.size,0); assert.equal(h.calls.sign,0); assert.equal(h.calls.broadcast.length,0);
    assert.equal(await h.repository.getAccount(),null);
  }
  const h = await transactionHarness(); h.state.actualChain = 10011n;
  await assert.rejects(h.manager.submitDelivery(h.jobs[0].deliveryJobId),{ code: "CHAIN_ID_MISMATCH" });
  assert.equal(h.calls.gas,0); assert.equal(h.calls.sign,0); assert.equal(h.records.size,0);
  const arbitrary = await transactionHarness();
  await assert.rejects(arbitrary.manager.submitDelivery({ to: arbitrary.packets[0].message.destinationReceiver,data: "0xffff",value: 1n }));
  assert.equal(arbitrary.records.size,0); assert.equal(arbitrary.calls.broadcast.length,0);
});

test("an existing intent cannot change sender, destination or exact calldata", async () => {
  for (const field of ["senderAddress","destinationGateway","calldata"]) {
    const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
    await h.manager.prepareDeliveryTransaction(id);
    h.records.get(id).intent[field] = field === "calldata" ? "0xffff" : h.packets[0].message.destinationReceiver;
    await assert.rejects(h.restart().prepareDeliveryTransaction(id),{ code: "CONFLICTING_TRANSACTION_INTENT" });
    assert.equal(h.calls.sign,1); assert.equal(h.records.size,1); assert.equal(h.calls.broadcast.length,0);
  }
});

test("gas, fees, signing and pre-commit failures leave no durable nonce or attempt", async () => {
  for (const kind of ["gas","fees","sign","commit"]) {
    const h = await transactionHarness({ beforeCommit: kind === "commit" ? async () => { throw new Error("injected DB commit failure"); } : undefined });
    if (kind === "gas") h.rpc.estimateGas = async () => { throw new Error("injected estimate failure"); };
    if (kind === "fees") h.rpc.fees = async () => ({ maxFeePerGas: 1n,maxPriorityFeePerGas: 2n });
    if (kind === "sign") h.options.account.signTransaction = async () => { throw new Error("injected signing failure"); };
    await assert.rejects(h.manager.submitDelivery(h.jobs[0].deliveryJobId));
    assert.equal(h.records.size,0); assert.equal(await h.repository.getAccount(),null); assert.equal(h.calls.broadcast.length,0);
  }
});

test("matching broadcast observes prior SIGNED persistence and returns the exact durable hash", async () => {
  const h = await transactionHarness();
  const result = await h.manager.submitDelivery(h.jobs[0].deliveryJobId);
  assert.equal(result.attempt.status,"BROADCAST"); assert.equal(result.submitted,true);
  assert.equal(h.calls.broadcast[0],result.attempt.rawSignedTransaction);
  assert.deepEqual(h.packets,h.original);
  assert.equal((await h.restart().submitDelivery(h.jobs[0].deliveryJobId)).submitted,false);
  assert.equal(h.calls.broadcast.length,1); assert.equal(h.calls.sign,1);
});

test("broadcast errors and wrong hashes retain SIGNED and block automatic higher-nonce progress", async () => {
  for (const wrongHash of [false,true]) {
    const h = await transactionHarness();
    h.rpc.broadcast = async raw => { h.calls.broadcast.push(raw); if (!wrongHash) throw new Error("injected send failure"); return fixtureHash(999); };
    await assert.rejects(h.manager.submitDelivery(h.jobs[0].deliveryJobId));
    const first = await h.repository.getTransactionAttempt(h.jobs[0].deliveryJobId);
    assert.equal(first.status,"SIGNED"); assert.equal(h.records.size,1); assert.equal(h.calls.broadcast.length,1);
    await assert.rejects(h.restart().submitDelivery(h.jobs[1].deliveryJobId),{ code: "SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST" });
    assert.equal(h.calls.sign,1); assert.equal((await h.repository.getAccount()).nextNonce,"10");
    const later = await h.manager.prepareDeliveryTransaction(h.jobs[1].deliveryJobId);
    assert.equal(later.attempt.nonce,"10");
    await assert.rejects(h.manager.broadcastPreparedTransaction(h.jobs[1].deliveryJobId),{ code: "EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST" });
    assert.equal(h.calls.broadcast.length,1);
    assert.deepEqual((await h.restart().prepareDeliveryTransaction(h.jobs[0].deliveryJobId)).attempt,first);
  }
});

test("private signing/RPC error values are redacted", async () => {
  const h = await transactionHarness();
  h.rpc.broadcast = async () => { throw new Error(`${h.config.privateKey} ${h.config.databaseUrl} ${h.config.destinationRpcUrl}`); };
  await assert.rejects(h.manager.submitDelivery(h.jobs[0].deliveryJobId),error => !error.message.includes(h.config.privateKey) &&
    !error.message.includes(h.config.databaseUrl) && !error.message.includes(h.config.destinationRpcUrl));
});

test("receipt absence and insufficient fixed-head depth preserve BROADCAST", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id);
  assert.equal((await h.manager.checkReceiptsOnce()).confirmed,0);
  h.mine(id); h.state.head = 101n;
  assert.equal((await h.manager.checkReceiptsOnce()).confirmed,0);
  assert.equal((await h.repository.getTransactionAttempt(id)).status,"BROADCAST");
  h.state.head = 102n;
  const result = await h.restart().checkReceiptsOnce();
  assert.equal(result.confirmed,1); assert.equal(result.head,"102"); assert.equal(h.calls.head,3);
  const confirmed = await h.repository.getTransactionAttempt(id);
  assert.equal(confirmed.status,"CONFIRMED"); assert.equal(confirmed.receiptBlockNumber,"100"); assert.equal(confirmed.confirmedHead,"102");
  assert.equal((await h.manager.checkReceiptsOnce()).checked,0);
  assert.deepEqual(await h.repository.getTransactionAttempt(id),confirmed);
});

test("receipt hash, canonical block and transaction-field conflicts never confirm", async () => {
  for (const kind of ["hash","block","sender","target","input","nonce","chain","gas","fee"]) {
    const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
    const result = await h.manager.submitDelivery(id); h.mine(id); h.state.head = 102n;
    const hash = result.attempt.transactionHash;
    if (kind === "hash") h.state.receipts.get(hash).transactionHash = fixtureHash(99);
    else if (kind === "block") h.state.blocks.get("100").hash = fixtureHash(99);
    else {
      const tx = h.state.transactions.get(hash);
      if (kind === "sender") tx.from = h.packets[0].message.destinationReceiver;
      if (kind === "target") tx.to = h.packets[0].message.destinationReceiver;
      if (kind === "input") tx.input = "0xffff";
      if (kind === "nonce") tx.nonce = "0x99";
      if (kind === "chain") tx.chainId = "0x1";
      if (kind === "gas") tx.gas = "0x1";
      if (kind === "fee") tx.maxFeePerGas = "0x1";
    }
    await assert.rejects(h.manager.checkReceiptsOnce());
    assert.equal((await h.repository.getTransactionAttempt(id)).status,"BROADCAST");
  }
});

test("canonical EVM revert becomes durable REVERTED without retries", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id,{ status: 0 });
  assert.equal((await h.manager.checkReceiptsOnce()).reverted,0);
  assert.equal((await h.repository.getTransactionAttempt(id)).status,"BROADCAST");
  h.state.head = 102n;
  const result = await h.manager.checkReceiptsOnce();
  assert.equal(result.reverted,1); assert.equal(result.confirmed,0);
  const record = await h.restart().repository.getTransactionAttempt(id);
  assert.equal(record.status,"REVERTED"); assert.equal(record.receiptStatus,0);
  assert.equal((await h.manager.submitDelivery(id)).submitted,false); assert.equal(h.calls.broadcast.length,1); assert.equal(h.calls.sign,1);
});

test("receipt pass does not refresh its fixed head when RPC progresses during inspection", async () => {
  const h = await transactionHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id);
  const originalReceipt = h.rpc.receipt;
  h.rpc.receipt = async hash => { h.state.head = 102n; return originalReceipt(hash); };
  const first = await h.manager.checkReceiptsOnce();
  assert.equal(first.head,"100"); assert.equal(first.confirmed,0); assert.equal(h.calls.head,1);
  assert.equal((await h.manager.checkReceiptsOnce()).confirmed,1); assert.equal(h.calls.head,2);
});

test("production Relayer delegates only verified job identities and excludes final intents before its limit", async () => {
  const h = await transactionHarness({ config: transactionConfig({ RELAYER_MAX_JOBS_PER_RUN: "2" }) });
  const leases = memoryLeaseFixture(h).repository();
  const relayer = createRelayerWorker({ config: h.config,queue: h.queue,leases,transactionManager: h.manager });
  assert.equal((await relayer.runOnce()).submitted,2);
  h.mine(h.jobs[0].deliveryJobId); h.mine(h.jobs[1].deliveryJobId); h.state.head = 102n;
  await h.manager.checkReceiptsOnce();
  assert.equal((await relayer.runOnce()).submitted,1);
  h.mine(h.jobs[2].deliveryJobId); await h.manager.checkReceiptsOnce();
  assert.equal((await relayer.runOnce()).selected,0);
  assert.equal(h.calls.broadcast.length,3); assert.equal(h.records.size,3);
  assert.deepEqual(h.packets,h.original);
});
