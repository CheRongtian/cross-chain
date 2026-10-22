import assert from "node:assert/strict";
import { join } from "node:path";
import { encodeAbiParameters,parseAbiParameters,decodeEventLog,parseTransaction } from "viem";
import { prepareAuthorizedSourceMessage } from "../../src/authorized-source-message.mjs";
import { decodeCrossChainMessageLog } from "../../src/source-gateway-event.mjs";
import { tableName } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { loadDeliveryConfig } from "../../src/delivery/config.mjs";
import { encodeGatewaySubmission } from "../../src/relayer/encoding.mjs";
import { CREDENTIAL_PUBLIC_SIGNAL_ORDER } from "../../src/forward-authorization.mjs";
import { artifact,clients,successfulReceipt,writeContract } from "./deployment.mjs";
import { inspectLocalPrivacy } from "./privacy.mjs";
import { httpJson,jsonText,waitFor,writeJson } from "./tools.mjs";

export async function produceLocalSourceMessage({ config,pool,issuer,artifacts,alive,progress,signal,
  supplier: selectedSupplier,beforeSourceBroadcast = async () => {} }) {
  const a = clients(config.chainA,10011); const b = clients(config.chainB,2001);
  const d = config.deployments;
  const sourceAbi = (await artifact("SourceGateway")).abi;
  const destinationAbi = (await artifact("DestinationGateway")).abi;
  const applicationBAbi = (await artifact("ApplicationB")).abi;
  const readB = (address,abi,functionName,args) => b.publicClient.readContract({ address,abi,functionName,args });
  let trackedMessageId;
  const wait = async (label,operation) => {
    try { return await waitFor(label,operation,{ timeout: 90000,alive,retryErrors: false }); }
    catch (error) {
      if (error.message.startsWith("Timed out") && trackedMessageId) {
        // Read-only diagnostics: never turn a timeout into protocol-state repair.
        try {
          const rows = await pool.query(`SELECT s.status AS source_status,b.status AS batch_status,j.status AS delivery_status,i.status AS intent_status,i.retry_stop_reason
          FROM ${tableName(config.schema,"source_messages")} s
          LEFT JOIN ${tableName(config.schema,"message_batch_members")} m ON m.source_message_id = s.id
          LEFT JOIN ${tableName(config.schema,"message_batches")} b USING (batch_record_id)
          LEFT JOIN ${tableName(config.schema,"delivery_jobs")} j ON j.source_message_id = s.id AND j.batch_record_id = b.batch_record_id
          LEFT JOIN ${tableName(config.schema,"transaction_intents")} i USING (delivery_job_id)
          WHERE s.message_id = $1`,[trackedMessageId]);
          progress("Last persisted lifecycle: " + jsonText(rows.rows));
        } catch { progress("Last persisted lifecycle could not be read; the original timeout is retained"); }
      }
      throw error;
    }
  };
  const now = (await a.publicClient.getBlock()).timestamp;
  const nonce = await a.publicClient.readContract({ address: d.sourceGateway,abi: sourceAbi,functionName: "nextNonce" });
  // An explicit fresh business address, never a private subject/address claim.
  const supplier = selectedSupplier ?? "0x" + (0x100000n + nonce).toString(16).padStart(40,"0");
  assert.equal(await readB(d.applicationB,applicationBAbi,"isVerifiedSupplier",[supplier]),false,"new demo intent must target a fresh supplier");
  progress("Preparing a fresh synthetic credential and independent supplier intent");
  const privateCredential = issuer.issue(now);
  await writeJson(join(config.directory,"private",privateCredential.fixture + ".json"),privateCredential);
  await writeContract(a.publicClient,a.wallet,d.identityApplication,"IdentityApplicationA","updateCredentialStateRoot",[BigInt(privateCredential.state.root),[]]);
  const proofTimestamp = (await a.publicClient.getBlock()).timestamp;
  const authorizationValidUntil = proofTimestamp + 7200n;
  assert.ok(proofTimestamp < authorizationValidUntil && authorizationValidUntil <= BigInt(privateCredential.credential.expiry));
  const payload = encodeAbiParameters(parseAbiParameters("uint8,uint8,address"),[1,1,supplier]);
  const prepared = await prepareAuthorizedSourceMessage({ publicClient: a.publicClient,application: d.identityApplication,
    destinationDomain: 2001n,destinationGateway: d.destinationGateway,destinationReceiver: d.applicationB,payload,
    deadline: proofTimestamp + 14400n,executor: a.wallet.account.address,proofTimestamp,authorizationValidUntil,
    fixtureName: privateCredential.fixture,credential: privateCredential.credential,state: privateCredential.state,
    artifacts,temporaryParent: join(config.directory,"private"),privateInput: true,signal });
  assert.equal(prepared.publicSignals.length,CREDENTIAL_PUBLIC_SIGNAL_ORDER.length);
  assert.equal(BigInt(prepared.publicInputs.actionContext),3n);
  await beforeSourceBroadcast({ chain: a.publicClient });
  const hash = await a.wallet.writeContract({ address: d.identityApplication,abi: prepared.abi,functionName: "forwardAuthorizedMessage",args: prepared.args });
  const sourceReceipt = await successfulReceipt(a.publicClient,hash);
  const logs = sourceReceipt.logs.filter(log => log.address.toLowerCase() === d.sourceGateway);
  assert.equal(logs.length,1);
  const message = decodeCrossChainMessageLog(logs[0],{ expectedGateway: d.sourceGateway,expectedSourceDomain: 10011n });
  trackedMessageId = message.messageId;
  assert.equal(message.payload,payload); assert.equal(message.sourceSender,d.identityApplication);
  assert.equal(message.destinationGateway,d.destinationGateway); assert.equal(message.destinationReceiver,d.applicationB);
  assert.equal(message.nonce,nonce); assert.equal(message.sourceTransactionHash,hash);
  const forwarding = sourceReceipt.logs.filter(log => log.address.toLowerCase() === d.identityApplication)
    .map(log => decodeEventLog({ abi: prepared.abi,data: log.data,topics: log.topics,strict: true }))
    .filter(log => log.eventName === "AuthorizedMessageForwarded");
  assert.equal(forwarding.length,1); assert.equal(forwarding[0].args.messageId,message.messageId);
  assert.equal(forwarding[0].args.intentDigest,prepared.intentDigest);
  assert.equal(forwarding[0].args.nullifier,BigInt(prepared.publicInputs.nullifier));
  assert.equal((await a.publicClient.getBlock({ blockNumber: sourceReceipt.blockNumber })).hash,sourceReceipt.blockHash);
  assert.equal(await a.publicClient.readContract({ address: d.identityApplication,abi: prepared.abi,functionName: "usedNullifiers",args: [BigInt(prepared.publicInputs.nullifier)] }),true);
  progress(`Source transaction ${hash}; canonical message ${message.messageId}`);
  const sources = tableName(config.schema,"source_messages");
  const readSource = async () => (await pool.query(`SELECT * FROM ${sources} WHERE message_id = $1
    AND source_gateway = $2 AND source_tx_hash = $3 AND source_block_hash = $4 AND source_log_index = $5`,
  [message.messageId,d.sourceGateway,hash,sourceReceipt.blockHash,String(logs[0].logIndex)])).rows[0];
  await wait("persisted OBSERVED source occurrence",async () => {
    const row = await readSource();
    if (!row) return false;
    assert.equal(row.source_tx_hash,hash); assert.equal(row.source_block_hash,sourceReceipt.blockHash);
    assert.equal(row.source_log_index,String(logs[0].logIndex)); assert.ok(row.observed_at);
    return row;
  });
  progress("OBSERVED: canonical source event persisted by the live Indexer");
  return { a,b,d,sourceAbi,destinationAbi,applicationBAbi,readB,privateCredential,prepared,payload,supplier,
    message,sourceReceipt,hash,readSource,wait,progress };
}

export async function finalizeLocalSource({ a,sourceReceipt,readSource,wait,progress }) {
  await wait("FINALIZING before successor mining",async () => {
    const row = await readSource();
    if (row?.status === "FINALIZED") throw new Error("Source finalized before controlled successor mining");
    return row?.status === "FINALIZING" && row.finalizing_at ? row : false;
  });
  progress("FINALIZING: observed by the live Finality worker; mining two real successors");
  await a.publicClient.request({ method: "anvil_mine",params: ["0x2"] });
  const finalized = await wait("FINALIZED",async () => { const row = await readSource(); return row?.status === "FINALIZED" ? row : false; });
  assert.ok(finalized.finalized_at); assert.ok(BigInt(finalized.finalized_at_head) >= sourceReceipt.blockNumber + 2n);
  progress("FINALIZED: depth policy satisfied on the canonical source chain");
}

export async function runLocalDemo(options) {
  const { config,pool,progress,afterFinalized = async () => {},afterReady = async () => {},afterConfirmed = async () => {} } = options;
  const context = await produceLocalSourceMessage(options);
  const { a,b,d,destinationAbi,applicationBAbi,readB,privateCredential,payload,supplier,message,sourceReceipt,hash,wait } = context;
  await finalizeLocalSource(context);
  await afterFinalized({ messageId: message.messageId });
  const jobs = tableName(config.schema,"delivery_jobs");
  const batches = tableName(config.schema,"message_batches");
  const job = await wait("COMMITTED batch and READY delivery",async () => (await pool.query(`SELECT j.*,b.status AS batch_status,b.sealed_at,b.consensus_pending_at,b.committed_at
    FROM ${jobs} j JOIN ${batches} b USING (batch_record_id) WHERE j.message_id = $1`,[message.messageId])).rows[0]);
  assert.equal(job.batch_status,"COMMITTED"); assert.equal(job.status,"READY");
  assert.ok(job.sealed_at && job.consensus_pending_at && job.committed_at);
  const deliveryConfig = loadDeliveryConfig({ DATABASE_URL: pool.options.connectionString,INDEXER_DB_SCHEMA: config.schema,
    CHAIN_A_DOMAIN: "10011",SOURCE_GATEWAY_ADDRESS: d.sourceGateway,VALIDATOR_SET_HISTORY: JSON.stringify(config.history) });
  const pack = await createDeliveryRepository({ config: deliveryConfig,pool }).getDeliveryPackage(job.delivery_job_id);
  assert.equal(pack.message.messageId,message.messageId); assert.equal(pack.message.payload,payload);
  const qc = pack.quorumCertificate;
  assert.equal(qc.protocolVersion,"3"); assert.equal(qc.validatorEpoch,"7"); assert.equal(qc.view,"0");
  assert.ok(qc.commits.length >= 3); assert.equal(new Set(qc.commits.map(vote => vote.voterIdentity)).size,qc.commits.length);
  assert.ok(qc.commits.every(vote => config.peers.some(peer => peer.address === vote.voterIdentity)));
  progress(`SEALED → CONSENSUS_PENDING → COMMITTED: batch ${pack.batchId}; Merkle root ${pack.messageRoot}; QC ${qc.qcDigest}; epoch ${qc.validatorEpoch}/view ${qc.view}`);
  progress(`READY: delivery ${job.delivery_job_id}`);
  await afterReady({ messageId: message.messageId,supplier,pack,job,deliveryConfig });
  const attempts = tableName(config.schema,"transaction_attempts");
  const intents = tableName(config.schema,"transaction_intents");
  const broadcast = await wait("durably signed and broadcast destination transaction",async () => (await pool.query(`SELECT * FROM ${attempts}
    WHERE delivery_job_id = $1 AND broadcast_at IS NOT NULL ORDER BY attempt_id DESC LIMIT 1`,[job.delivery_job_id])).rows[0]);
  assert.ok(broadcast.raw_signed_transaction);
  assert.ok(broadcast.created_at <= broadcast.broadcast_at,"signed journal persistence must precede broadcast evidence");
  const signed = parseTransaction(broadcast.raw_signed_transaction);
  assert.equal(BigInt(signed.nonce),BigInt(broadcast.nonce));
  assert.equal(BigInt(signed.chainId),2001n);
  progress(`SIGNED → BROADCAST: journaled transaction ${broadcast.transaction_hash}; mining destination confirmations`);
  const receipt = await successfulReceipt(b.publicClient,broadcast.transaction_hash);
  await b.publicClient.request({ method: "anvil_mine",params: ["0x3"] });
  const confirmed = await wait("CONFIRMED canonical transaction intent",async () => {
    const intent = (await pool.query(`SELECT * FROM ${intents} WHERE delivery_job_id = $1`,[job.delivery_job_id])).rows[0];
    if (intent?.status === "REVERTED" || intent?.retry_stopped_at) throw new Error(`Destination intent stopped: ${intent.status} ${intent.retry_stop_reason ?? ""}`);
    return intent?.status === "CONFIRMED" ? intent : false;
  });
  const winner = (await pool.query(`SELECT * FROM ${attempts} WHERE attempt_id = $1`,[confirmed.winning_attempt_id])).rows[0];
  assert.equal(winner.transaction_hash,receipt.transactionHash); assert.equal(winner.receipt_block_hash,receipt.blockHash);
  assert.equal((await b.publicClient.getBlock({ blockNumber: receipt.blockNumber })).hash,receipt.blockHash);
  assert.ok(BigInt(winner.confirmed_head) - receipt.blockNumber + 1n >= 3n);
  const transaction = await b.publicClient.getTransaction({ hash: receipt.transactionHash });
  const encoded = await encodeGatewaySubmission(pack,{ validatorSets: deliveryConfig.validatorSets });
  assert.equal(transaction.input,encoded.calldata); assert.equal(confirmed.calldata,encoded.calldata); assert.equal(signed.data,encoded.calldata);
  assert.equal(transaction.to.toLowerCase(),d.destinationGateway); assert.equal(transaction.nonce,Number(winner.nonce));
  const messageExecuted = await readB(d.destinationGateway,destinationAbi,"isMessageExecuted",[message.messageId]);
  const supplierVerified = await readB(d.applicationB,applicationBAbi,"isVerifiedSupplier",[supplier]);
  assert.equal(messageExecuted,true); assert.equal(supplierVerified,true);
  const decode = (address,abi) => receipt.logs.filter(log => log.address.toLowerCase() === address).map(log => decodeEventLog({ abi,data: log.data,topics: log.topics,strict: true }));
  const execution = decode(d.destinationGateway,destinationAbi).filter(log => log.eventName === "CrossChainMessageExecuted");
  const grants = decode(d.applicationB,applicationBAbi).filter(log => log.eventName === "VerifiedSupplierGranted");
  assert.equal(execution.length,1); assert.equal(grants.length,1);
  assert.equal(execution[0].args.messageId,message.messageId); assert.equal(execution[0].args.batchId,pack.batchId);
  assert.equal(execution[0].args.destinationReceiver.toLowerCase(),d.applicationB); assert.equal(execution[0].args.sourceDomain,10011n);
  assert.equal(grants[0].args.messageId,message.messageId); assert.equal(grants[0].args.supplier.toLowerCase(),supplier);
  const body = await wait("Explorer canonical confirmation",async () => {
    const value = await httpJson(config.api + "/api/v1/messages/" + message.messageId);
    return value.execution?.status === "CONFIRMED" ? value : false;
  });
  assert.equal(body.destinationTransaction.transactionHash,receipt.transactionHash); assert.equal(body.batch.batchId,pack.batchId);
  assert.equal(body.qc.qcDigest,qc.qcDigest);
  await afterConfirmed({ messageId: message.messageId,qc });
  await inspectLocalPrivacy({ config,messageId: message.messageId,privateCredential,
    destination: { calldata: transaction.input,logs: receipt.logs,state: { messageExecuted,supplierVerified } },progress });
  const result = { messageId: message.messageId,sourceTransaction: hash,sourceBlock: sourceReceipt.blockNumber.toString(),sourceBlockHash: sourceReceipt.blockHash,
    batchId: pack.batchId,messageRoot: pack.messageRoot,qcDigest: qc.qcDigest,validatorEpoch: qc.validatorEpoch,view: qc.view,
    deliveryJobId: job.delivery_job_id,destinationTransaction: receipt.transactionHash,destinationBlockHash: receipt.blockHash,
    supplier,supplierVerified,messageExecuted,privacy: "PASSED",explorer: config.api + "/?messageId=" + message.messageId };
  await writeJson(join(config.directory,"demo-result.json"),result);
  progress("CONFIRMED: canonical Gateway execution, exactly one grant and Application B state agree");
  return result;
}
