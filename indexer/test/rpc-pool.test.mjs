import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "viem";
import { loadRelayerConfig, publicRelayerConfig, safeRelayerMessage } from "../src/relayer/config.mjs";
import { relayerEnvironment } from "./helpers/relayer-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { transactionConfig } from "./helpers/transaction-fixtures.mjs";
import { destinationRpcFixture, transactionFailoverHarness, rpcUnavailable, rpcTimeout, rpcRejection } from "./helpers/destination-rpc-fixtures.mjs";

test("ordered endpoints, normalized duplicates, fingerprint and timeout configuration", () => {
  const env = relayerEnvironment({ CHAIN_B_RPC_URLS: '["http://localhost:9545","http://localhost:9546"]' });
  const config = loadRelayerConfig(env);
  assert.deepEqual(config.destinationRpcUrls,["http://localhost:9545/","http://localhost:9546/"]);
  assert.equal(config.rpcRequestTimeoutMs,10000);
  assert.deepEqual(publicRelayerConfig(config).rpcEndpoints,[{ label: "rpc-0",priority: 0 },{ label: "rpc-1",priority: 1 }]);
  for (const overrides of [
    { CHAIN_B_RPC_URLS: "[]" },{ CHAIN_B_RPC_URLS: "{}" },{ CHAIN_B_RPC_URLS: "broken" },
    { CHAIN_B_RPC_URLS: '[""]' },{ CHAIN_B_RPC_URLS: '["http://localhost:9545",null]' },
    { CHAIN_B_RPC_URLS: '["file:///unused"]' },{ CHAIN_B_RPC_URLS: '["http://localhost:9545#fragment"]' },
    { CHAIN_B_RPC_URLS: '["http:localhost:9545"]' },
    { CHAIN_B_RPC_URLS: '["http://localhost:9545","http://localhost:9545/"]' },
    { CHAIN_B_GENESIS_HASH: undefined },{ CHAIN_B_GENESIS_HASH: "0x12" },
    { RPC_REQUEST_TIMEOUT_MS: "0" },{ RPC_REQUEST_TIMEOUT_MS: "2147483648" },{ RPC_REQUEST_TIMEOUT_MS: "1.5" },
  ]) assert.throws(() => loadRelayerConfig({ ...env,...overrides }));
  assert.equal(loadRelayerConfig(relayerEnvironment()).destinationRpcUrls.length,1);
});

test("a healthy primary handles ordinary operations without contacting the secondary", async () => {
  const f = destinationRpcFixture();
  assert.equal(await f.rpc.estimateGas({ senderAddress: f.config.relayerAddress,destinationGateway: "0x0000000000000000000000000000000000002001",calldata: "0x1234" }),123456n);
  assert.equal(f.nodes[1].calls.length,0);
  assert.equal(f.pool.health()[0].status,"HEALTHY");
});

test("identity mismatch is quarantined for this session, independently of transport failure", async () => {
  for (const kind of ["chain","genesis","malformed"]) {
    const f = destinationRpcFixture();
    if (kind === "chain") f.nodes[0].chainId = 10011n;
    else f.nodes[0].genesisHash = kind === "genesis" ? fixtureHash(999) : "bad hash";
    assert.equal(await f.rpc.verifyChain(),2001n);
    assert.equal(f.pool.health()[0].status,"IDENTITY_MISMATCH");
    const before = f.nodes[0].calls.length;
    f.nodes[0].chainId = 2001n; f.nodes[0].genesisHash = f.config.destinationGenesisHash;
    await f.rpc.verifyChain();
    assert.equal(f.nodes[0].calls.length,before);
    assert.equal((await f.restart().rpc.verifyChain()),2001n);
  }
});

test("temporary primary failure recovers and later operations prefer it again", async () => {
  const f = destinationRpcFixture(); f.nodes[0].available = false;
  assert.equal(await f.rpc.verifyChain(),2001n); assert.equal(f.pool.health()[0].status,"UNAVAILABLE");
  const before = f.nodes[1].calls.length; f.nodes[0].available = true;
  await f.rpc.verifyChain(); assert.equal(f.pool.health()[0].status,"HEALTHY");
  assert.equal(f.nodes[1].calls.length,before);
});

test("the complete request deadline aborts a stalled operation and continues through secondary", async () => {
  const f = destinationRpcFixture({ config: transactionConfig({
    CHAIN_B_RPC_URLS: '["http://localhost:9545","http://localhost:9546"]',RPC_REQUEST_TIMEOUT_MS: "25",
  }) });
  let aborted = false;
  f.nodes[0].faults.set("eth_chainId",({ signal }) => new Promise((_,reject) => {
    signal.addEventListener("abort",() => { aborted = true; reject(signal.reason); },{ once: true });
  }));
  assert.equal(await f.rpc.verifyChain(),2001n);
  assert.equal(aborted,true); assert.equal(f.pool.health()[0].lastErrorClass,"AMBIGUOUS_BROADCAST");
  assert.equal(f.pool.health()[1].status,"HEALTHY");
});

test("all endpoint failures expose a clear secret-free transient RPC_UNAVAILABLE", async () => {
  const f = destinationRpcFixture(); f.nodes.forEach(n => { n.available = false; });
  await assert.rejects(f.rpc.verifyChain(),e => e.code === "RPC_UNAVAILABLE" && e.errorClass === "TRANSIENT_RPC_ERROR" &&
    e.observations.length === 2 && !JSON.stringify(e).includes("http"));
});

test("gas and complete fee data fail over without mixing provider fields", async () => {
  const f = destinationRpcFixture(); f.nodes[0].faults.set("eth_estimateGas",() => { throw rpcUnavailable(); });
  f.nodes[1].gas = 222222n;
  assert.equal(await f.rpc.estimateGas({ senderAddress: f.config.relayerAddress,destinationGateway: "0x0000000000000000000000000000000000002001",calldata: "0x1234" }),222222n);
  f.nodes[0].faults.set("eth_maxPriorityFeePerGas",() => { throw rpcUnavailable(); });
  f.nodes[1].baseFee = 700n; f.nodes[1].priorityFee = 90n;
  assert.deepEqual(await f.rpc.fees(),{ maxFeePerGas: 1490n,maxPriorityFeePerGas: 90n });
});

test("account nonce aggregation uses the maximum and tolerates an unavailable provider", async () => {
  const f = destinationRpcFixture();
  f.nodes[0].pendingNonce = 9n; f.nodes[1].pendingNonce = (1n << 100n) + 11n;
  assert.equal(await f.rpc.pendingNonce(),f.nodes[1].pendingNonce);
  f.nodes[0].faults.set("eth_getTransactionCount",() => { throw rpcUnavailable(); });
  assert.equal(await f.rpc.pendingNonce(),f.nodes[1].pendingNonce);
  f.nodes[1].latestNonce = 11n;
  assert.equal(await f.rpc.latestNonce(),11n);
});

test("wrong-fingerprint endpoints never supply an authoritative nonce or receive signed bytes", async () => {
  const f = destinationRpcFixture();
  f.nodes[1].genesisHash = fixtureHash(999); f.nodes[1].pendingNonce = 100n;
  assert.equal(await f.rpc.pendingNonce(),9n);
  assert.equal(f.pool.health()[1].status,"IDENTITY_MISMATCH");
  assert.equal(f.nodes[1].calls.some(call => call.method === "eth_getTransactionCount"),false);
  const g = destinationRpcFixture(); g.nodes[0].chainId = 10011n;
  const raw = "0x0201"; await g.pool.broadcast(raw,keccak256(raw));
  assert.equal(g.nodes[0].broadcasts.length,0); assert.deepEqual(g.nodes[1].broadcasts,[raw]);
});

test("fixed conservative heads tolerate lag and reject same-height block conflicts", async () => {
  const f = destinationRpcFixture(); f.nodes[1].head = 98n;
  const view = await f.rpc.readView(); assert.equal(view.head,98n);
  assert.ok(f.pool.health().every(e => e.status === "HEALTHY"));
  f.nodes[0].head = 120n; f.nodes[1].head = 118n;
  f.nodes[1].blocks.set("118",{ number: "0x76",hash: fixtureHash(999) });
  await assert.rejects(f.rpc.readView(),{ code: "INCONSISTENT_RPC_VIEW" });
});

test("all-down after SIGNED persistence retains history, nonce, queue and recovery uses exact bytes", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  const prepared = await h.manager.prepareDeliveryTransaction(id); const account = await h.repository.getAccount();
  h.destination.nodes.forEach(n => { n.available = false; });
  await assert.rejects(h.manager.broadcastPreparedTransaction(id),{ code: "RPC_UNAVAILABLE" });
  const retained = await h.repository.getTransaction(id);
  assert.deepEqual(retained.attempts,prepared.attempts); assert.deepEqual(await h.repository.getAccount(),account);
  h.destination.nodes[1].available = true;
  const sent = await h.restart().broadcastPreparedTransaction(id);
  assert.equal(sent.acceptedEndpointLabel,"rpc-1");
  assert.equal(sent.attempt.rawSignedTransaction,prepared.attempt.rawSignedTransaction);
  assert.equal(sent.attempt.transactionHash,prepared.attempt.transactionHash);
  assert.equal(sent.attempts.length,1); assert.equal(h.calls.sign,1);
  assert.deepEqual(h.packets,h.original); assert.deepEqual(await h.repository.getAccount(),account);
});

test("a primary broadcast transport failure sends the identical persisted raw transaction through secondary", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  const first = await h.manager.prepareDeliveryTransaction(id);
  const count = method => h.destination.nodes.flatMap(node => node.calls).filter(call => call.method === method).length;
  const gas = count("eth_estimateGas"); const fees = count("eth_maxPriorityFeePerGas"); const account = await h.repository.getAccount();
  h.destination.nodes[0].faults.set("eth_sendRawTransaction",({ node,params }) => { node.broadcasts.push(params[0]); throw rpcTimeout(); });
  const sent = await h.manager.broadcastPreparedTransaction(id);
  assert.equal(sent.acceptedEndpointLabel,"rpc-1");
  assert.deepEqual(h.destination.nodes.map(n => n.broadcasts),[[first.attempt.rawSignedTransaction],[first.attempt.rawSignedTransaction]]);
  assert.equal(sent.attempts.length,1); assert.equal(h.calls.sign,1);
  assert.equal(count("eth_estimateGas"),gas); assert.equal(count("eth_maxPriorityFeePerGas"),fees);
  assert.deepEqual(await h.repository.getAccount(),account);
  assert.equal(sent.rpcObservations[0].errorClass,"AMBIGUOUS_BROADCAST");
});

test("accepted primary timeout followed by secondary already-known reconciles one exact attempt", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  h.destination.nodes[0].faults.set("eth_sendRawTransaction",async ({ forward }) => { await forward(); throw rpcTimeout(); });
  h.destination.nodes[1].alreadyKnown = true;
  const sent = await h.manager.submitDelivery(id);
  assert.equal(sent.reconciled,true); assert.equal(sent.attempt.status,"BROADCAST");
  assert.equal(sent.attempts.length,1); assert.equal(h.calls.sign,1);
  assert.equal(h.destination.transactions.size,1); assert.equal((await h.repository.getAccount()).nextNonce,"10");
});

test("transaction rejection never blind-hops to another endpoint", async () => {
  for (const message of ["replacement transaction underpriced","nonce too low","intrinsic gas too low","invalid sender"]) {
    const f = destinationRpcFixture();
    f.nodes[0].faults.set("eth_sendRawTransaction",() => { throw rpcRejection(message); });
    await assert.rejects(f.pool.broadcast("0x0201",keccak256("0x0201")));
    assert.equal(f.nodes[1].calls.length,0);
  }
});

test("wrong returned hash fails closed without another broadcast or signed candidate", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.prepareDeliveryTransaction(id);
  h.destination.nodes[0].faults.set("eth_sendRawTransaction",() => { throw rpcUnavailable(); });
  h.destination.nodes[1].returnedHash = fixtureHash(999);
  await assert.rejects(h.manager.broadcastPreparedTransaction(id),{ code: "RPC_TRANSACTION_HASH_MISMATCH" });
  const record = await h.repository.getTransaction(id);
  assert.equal(record.attempt.status,"SIGNED"); assert.equal(record.attempts.length,1); assert.equal(h.calls.sign,1);
  assert.equal(record.intent.retryStopReason,"RPC_TRANSACTION_HASH_MISMATCH");
});

test("null receipt on primary discovers a valid secondary receipt with exact source evidence", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id);
  h.destination.nodes[0].hideReceipts = true; h.destination.nodes[0].hideTransactions = true;
  assert.equal((await h.manager.checkReceiptsOnce()).confirmed,1);
  assert.equal((await h.repository.getTransaction(id)).intent.status,"CONFIRMED");
});

test("receipt evidence fails over after its source path becomes unavailable", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id); h.destination.nodes[0].available = false;
  assert.equal((await h.restart().checkReceiptsOnce()).confirmed,1);
});

test("a receipt RPC failure within a sampled pass continues through another sampled source", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id);
  h.destination.nodes[0].faults.set("eth_getTransactionReceipt",() => { throw rpcUnavailable(); });
  assert.equal((await h.manager.checkReceiptsOnce()).confirmed,1);
  assert.ok(h.destination.nodes[1].calls.some(call => call.method === "eth_getTransactionReceipt"));
});

test("canonical evidence after response loss establishes BROADCAST without raising a fixed head", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  h.destination.nodes[0].faults.set("eth_sendRawTransaction",async ({ forward }) => {
    await forward(); h.mine(id,{ blockNumber: 101n }); throw rpcTimeout();
  });
  h.destination.nodes[1].alreadyKnown = true;
  const signed = await h.manager.prepareDeliveryTransaction(id);
  h.advance(h.config.rebroadcastIntervalMs);
  const retry = await h.manager.processTransactionRetriesOnce();
  assert.equal(retry.broadcasts,1); assert.equal(retry.replacements,0);
  const record = await h.repository.getTransaction(id);
  assert.equal(record.attempt.transactionHash,signed.attempt.transactionHash);
  assert.equal(record.attempt.status,"BROADCAST"); assert.equal(record.intent.status,"PENDING");
  assert.equal(record.attempt.receiptBlockNumber,null);
  assert.equal((await h.manager.checkReceiptsOnce()).confirmed,1);
});

test("a lagging secondary limits depth without invalidating an observed mined transaction", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id); h.destination.nodes[1].head = 98n; h.destination.nodes[1].hideReceipts = true;
  assert.equal((await h.manager.checkReceiptsOnce()).confirmed,0);
  assert.equal((await h.repository.getTransaction(id)).intent.status,"PENDING");
  h.advance(h.config.replacementAfterMs);
  assert.equal((await h.manager.processTransactionRetriesOnce()).replacements,0);
  h.destination.nodes[1].head = 102n;
  assert.equal((await h.manager.checkReceiptsOnce()).confirmed,1);
});

test("conflicting block hashes leave intent pending and never record a winner", async () => {
  const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
  await h.manager.submitDelivery(id); h.mine(id);
  h.destination.nodes[1].blocks.set("100",{ number: "0x64",hash: fixtureHash(999) });
  await assert.rejects(h.manager.checkReceiptsOnce(),{ code: "INCONSISTENT_RPC_VIEW" });
  const record = await h.repository.getTransaction(id);
  assert.equal(record.intent.status,"PENDING"); assert.equal(record.intent.winningAttemptId,null);
});

test("replacement identity and an old canonical winner survive provider changes", async () => {
  for (const oldWins of [true,false]) {
    const h = await transactionFailoverHarness(); const id = h.jobs[0].deliveryJobId;
    const original = await h.manager.submitDelivery(id); h.advance(h.config.replacementAfterMs);
    const child = await h.manager.prepareReplacement(id); const account = await h.repository.getAccount();
    h.destination.nodes[0].available = false;
    const sent = await h.restart().broadcastPreparedTransaction(id);
    assert.equal(sent.attempt.rawSignedTransaction,child.attempt.rawSignedTransaction);
    assert.equal(sent.attempt.nonce,original.attempt.nonce); assert.equal(sent.attempts.length,2);
    assert.deepEqual(await h.repository.getAccount(),account);
    const winner = oldWins ? original.attempt : child.attempt;
    h.mine(id,{ attemptId: winner.attemptId });
    assert.equal((await h.restart().checkReceiptsOnce()).confirmed,1);
    assert.equal((await h.repository.getTransaction(id)).intent.winningAttemptId,winner.attemptId);
    assert.equal((await h.manager.processTransactionRetriesOnce()).processed,0);
  }
});

test("durable allocation never regresses when the newly selected provider has a lower nonce", async () => {
  const h = await transactionFailoverHarness(); h.destination.nodes[1].pendingNonce = 11n;
  const first = await h.manager.prepareDeliveryTransaction(h.jobs[0].deliveryJobId);
  assert.equal(first.intent.nonce,"11");
  h.destination.nodes[1].available = false; h.destination.nodes[0].pendingNonce = 9n;
  const second = await h.restart().prepareDeliveryTransaction(h.jobs[1].deliveryJobId);
  assert.equal(second.intent.nonce,"12"); assert.equal((await h.repository.getAccount()).nextNonce,"13");
});

test("provider credentials and path API tokens never appear in public errors or health", async () => {
  const secretUrl = "https://user:private-password@provider.example/api/private-token?key=private-query";
  const config = loadRelayerConfig(relayerEnvironment({ CHAIN_B_RPC_URLS: JSON.stringify([secretUrl,"http://localhost:9546"]) }));
  const f = destinationRpcFixture({ config });
  f.nodes[0].faults.set("eth_sendRawTransaction",() => { throw new Error(`rejected ${secretUrl}`); });
  await assert.rejects(f.pool.broadcast("0x0201",keccak256("0x0201")),error => {
    const exposed = JSON.stringify(error) + error.message + JSON.stringify(f.pool.health()) + JSON.stringify(publicRelayerConfig(config));
    return !["private-password","private-token","private-query","provider.example"].some(secret => exposed.includes(secret));
  });
  assert.ok(!safeRelayerMessage(new Error(config.destinationRpcUrls.join(" ")),config).includes("private-token"));
});
