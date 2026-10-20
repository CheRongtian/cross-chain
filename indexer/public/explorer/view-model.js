const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const address = value => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const decimal = value => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const requireData = condition => { if (!condition) throw new Error("INCONSISTENT_LIFECYCLE_DATA"); };

export function normalizeMessageId(value) {
  if (typeof value !== "string" || !hash(value.trim())) throw new Error("INVALID_MESSAGE_ID");
  return value.trim().toLowerCase();
}
export function messageIdFromURL(value) {
  const url = new URL(value, "http://localhost");
  const ids = url.searchParams.getAll("messageId");
  if (!ids.length) return null;
  if (ids.length !== 1) throw new Error("INVALID_MESSAGE_ID");
  return normalizeMessageId(ids[0]);
}
export function messageURL(value, messageId) {
  const url = new URL(value, "http://localhost");
  url.searchParams.set("messageId", normalizeMessageId(messageId));
  return `${url.pathname}${url.search}${url.hash}`;
}
export function protocolIntegerText(value) {
  requireData(decimal(value));
  return value;
}
const text = value => {
  if (value == null) return "Not recorded";
  requireData(["string", "number", "boolean"].includes(typeof value));
  return String(value);
};
const field = (label, value) => ({ label, value: text(value) });
const integer = (label, value) => field(label, value == null ? null : protocolIntegerText(value));
const list = value => { requireData(Array.isArray(value)); return value; };
const section = (id, title, status, fields = [], extra = {}) => ({ id, title, status, fields, ...extra });
const scope = (value, message) => value.sourceDomain === message.sourceDomain && value.sourceGateway === message.sourceGateway;
const enumText = (value, values) => { requireData(values.includes(value)); return value; };
const hashField = value => { requireData(hash(value)); return value; };
const hexPayload = value => typeof value === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(value);

function checkLifecycle(data, requestedId) {
  requireData(object(data) && data.apiVersion === "1" && data.authority === "OBSERVATIONAL");
  const m = data.message;
  requireData(object(m) && m.messageId === normalizeMessageId(requestedId));
  for (const key of ["version", "sourceDomain", "destinationDomain", "nonce", "deadline"]) protocolIntegerText(m[key]);
  for (const key of ["sourceGateway", "sourceSender", "destinationGateway", "destinationReceiver"]) requireData(address(m[key]));
  requireData(hash(m.payloadHash) && hexPayload(m.payload));
  requireData(object(data.sourceTransaction) && hash(data.sourceTransaction.transactionHash) && data.sourceTransaction.sourceGateway === m.sourceGateway);
  protocolIntegerText(data.sourceTransaction.logIndex);
  requireData(object(data.sourceBlock) && hash(data.sourceBlock.blockHash)); protocolIntegerText(data.sourceBlock.blockNumber);
  requireData(object(data.finality));
  enumText(data.finality.status, ["OBSERVED", "FINALIZING", "FINALIZED", "REORGED"]);
  for (const name of ["batch", "merkle", "pbft", "qc", "delivery", "destinationTransaction", "execution", "zkAuthorization"]) {
    requireData(data[name] == null || object(data[name]));
  }
  list(data.sourceOccurrences); list(data.validatorVotes); list(data.deliveryAttempts);
  if (data.finality.status === "REORGED") {
    requireData([data.batch, data.merkle, data.pbft, data.qc, data.delivery, data.destinationTransaction, data.execution].every(value => value === null));
    requireData(!data.validatorVotes.length && !data.deliveryAttempts.length);
  }
  if (data.batch) requireData(data.finality.status === "FINALIZED" && scope(data.batch, m));
  if (data.merkle) requireData(data.batch && hash(data.merkle.root) && data.merkle.position === data.batch.position && data.merkle.memberCount === data.batch.memberCount);
  if (data.pbft?.committee != null) requireData(list(data.pbft.committee).every(address));
  if (data.qc) {
    const q = data.qc;
    requireData(data.batch?.status === "COMMITTED" && data.pbft?.status === "COMMITTED" && data.merkle && scope(q, m));
    enumText(q.protocolVersion, ["1", "2", "3"]);
    requireData(q.batchId === data.batch.batchId && q.epoch === data.batch.batchEpoch && q.messageRoot === data.merkle.root && hash(q.qcDigest));
    requireData(list(q.signers).every(address));
    if (data.pbft.committee) requireData(q.signers.every(signer => data.pbft.committee.includes(signer)));
  }
  if (data.delivery) requireData(data.qc && data.delivery.messageId === m.messageId && data.delivery.batchId === data.batch.batchId &&
    data.delivery.sourceDomain === m.sourceDomain && data.delivery.destinationDomain === m.destinationDomain &&
    data.delivery.destinationGateway === m.destinationGateway && data.delivery.destinationReceiver === m.destinationReceiver);
  if (data.deliveryAttempts.length || data.destinationTransaction) requireData(data.delivery);
  if (data.execution) {
    const e = data.execution; const d = data.destinationTransaction;
    requireData(d);
    enumText(e.status, ["CONFIRMED", "TRANSPORT_CONFIRMED", "REVERTED", "REORG_RECOVERY", "PENDING", "HISTORICAL"]);
    if (["CONFIRMED", "TRANSPORT_CONFIRMED", "REVERTED"].includes(e.status)) {
      requireData(d.canonicality === "PERSISTED_CANONICAL" && hash(d.transactionHash) && hash(d.blockHash) && object(e.receipt) && !e.receipt.orphaned);
      requireData(e.receipt.transactionHash === d.transactionHash && e.receipt.blockHash === d.blockHash);
      requireData(d.state === (e.status === "REVERTED" ? "REVERTED" : "CONFIRMED") && String(e.receipt.status) === (e.status === "REVERTED" ? "0" : "1"));
      requireData(data.deliveryAttempts.some(attempt => attempt.transactionHash === d.transactionHash));
      if (e.status === "CONFIRMED") requireData(e.gatewayCall === "execute(bytes)");
    } else requireData(d.transactionHash === null);
    if (e.status === "REORG_RECOVERY") requireData(d.canonicality === "REORG_RECOVERY" && d.state === "PENDING");
  }
  const a = data.zkAuthorization;
  if (a) {
    enumText(a.status, ["AUTHORIZED", "HISTORICAL_AUTHORIZED", "UNAVAILABLE"]);
    if (a.status !== "UNAVAILABLE") {
      requireData(a.basis === "CONFIGURED_PRODUCTION_APPLICATION_PATH" && a.application === m.sourceSender && scope(a, m) &&
        a.transactionHash === data.sourceTransaction.transactionHash && a.blockHash === data.sourceBlock.blockHash &&
        a.logIndex === data.sourceTransaction.logIndex && a.sourceStatus === data.finality.status);
      requireData((a.status === "HISTORICAL_AUTHORIZED") === (data.finality.status === "REORGED"));
    }
  }
}

function receiptRecord(receipt, destination) {
  requireData(object(receipt) && typeof receipt.orphaned === "boolean");
  const current = !receipt.orphaned && destination?.transactionHash === receipt.transactionHash && destination?.blockHash === receipt.blockHash;
  return { title: receipt.orphaned ? "Historical / orphaned receipt" : current ? "Current canonical receipt observation" : "Historical receipt observation",
    status: receipt.orphaned ? "ORPHANED" : current ? "CURRENT" : "HISTORICAL",
    fields: [field("Transaction hash", hashField(receipt.transactionHash)), integer("Block number", receipt.blockNumber),
      field("Block hash", hashField(receipt.blockHash)), field("Receipt status", receipt.status), integer("Confirmed head", receipt.confirmedHead),
      field("Confirmed at", receipt.confirmedAt), field("Replacement block hash", receipt.replacementBlockHash)] };
}

export function orderedAttempts(attempts, destination) {
  const values = list(attempts).map(attempt => {
    requireData(object(attempt)); protocolIntegerText(attempt.attemptIndex); protocolIntegerText(attempt.nonce); hashField(attempt.transactionHash);
    return attempt;
  });
  const sorted = [...values].sort((a, b) => a.attemptIndex.length !== b.attemptIndex.length ?
    a.attemptIndex.length < b.attemptIndex.length ? -1 : 1 : a.attemptIndex < b.attemptIndex ? -1 : a.attemptIndex > b.attemptIndex ? 1 : 0);
  return sorted.map(attempt => ({ title: `Attempt ${attempt.attemptIndex}`, status: attempt.status,
    fields: [integer("Attempt index", attempt.attemptIndex), field("Attempt ID", attempt.attemptId), field("State", attempt.status),
      field("Transaction hash", attempt.transactionHash), field("Canonical winner", destination?.transactionHash === attempt.transactionHash ? "Yes" : "No"),
      field("Replaces attempt", attempt.replacementOfAttemptId), integer("Nonce", attempt.nonce), integer("Gas limit", attempt.gasLimit),
      integer("Max fee per gas (wei)", attempt.maxFeePerGas), integer("Priority fee (wei)", attempt.maxPriorityFeePerGas),
      field("Broadcast attempts", attempt.broadcastAttemptCount), field("Broadcast at", attempt.broadcastAt), field("Last error class", attempt.lastErrorClass)],
    details: [{ title: "Broadcast journal", records: list(attempt.broadcasts).map(event => ({ title: `Broadcast ${text(event.sequence)}`,
      fields: [field("Endpoint label", event.endpointLabel), field("Result class", event.resultClass), field("Error class", event.errorClass),
        field("Started at", event.startedAt), field("Completed at", event.completedAt)] })) },
    { title: "Receipt history", records: list(attempt.receipts).map(value => receiptRecord(value, destination)) }] }));
}

export function buildMessageView(data, requestedId) {
  checkLifecycle(data, requestedId);
  const m = data.message; const f = data.finality; const b = data.batch; const p = data.pbft; const q = data.qc;
  const d = data.destinationTransaction; const e = data.execution; const a = data.zkAuthorization;
  const reorged = f.status === "REORGED";
  const executionLabels = { CONFIRMED: "Executed successfully (persisted observation)", TRANSPORT_CONFIRMED: "Transport confirmed; application execution unproven",
    REVERTED: "Destination transaction reverted", REORG_RECOVERY: "Recovering after destination reorg", PENDING: "Pending", HISTORICAL: "Historical submission; execution unconfirmed" };
  const executionLabel = e ? executionLabels[e.status] : "Not executed";
  const authLabel = a?.status === "AUTHORIZED" ? "AUTHORIZED — production application path observed" :
    a?.status === "HISTORICAL_AUTHORIZED" ? "Historical authorization on reorged source branch" : "Authorization evidence unavailable";
  const attempts = orderedAttempts(data.deliveryAttempts, d);
  const votes = data.validatorVotes.map(vote => {
    requireData(object(vote) && address(vote.signer)); enumText(vote.phase, ["PREPARE", "COMMIT"]);
    if (vote.messageRoot != null) requireData(vote.messageRoot === data.merkle?.root);
    return { title: `${vote.phase} · ${vote.signer}`, status: "PERSISTED VOTE", fields: [field("Validator", vote.signer), field("Phase", vote.phase),
      integer("View", vote.view), integer("Validator epoch", vote.validatorEpoch), field("Message Root", vote.messageRoot),
      field("Batch ID", vote.batchId), field("Committee digest", vote.committeeDigest)],
      details: [{ title: "Public vote evidence", fields: [field("Digest", vote.digest), field("Proposal digest", vote.proposalDigest),
        field("Signature", vote.signature), field("Observed by", vote.observedBy == null ? null : list(vote.observedBy).join("\n"))] }] };
  });
  const commits = new Set(data.validatorVotes.filter(vote => vote.phase === "COMMIT").map(vote => vote.signer));
  const sections = [
    section("source", "Source", reorged ? "Reorged from canonical history" : "Observed on Chain A", [integer("Source domain", m.sourceDomain),
      field("SourceGateway", m.sourceGateway), field("Source sender", m.sourceSender), field("Source transaction", data.sourceTransaction.transactionHash),
      integer("Log index", data.sourceTransaction.logIndex), integer("Block number", data.sourceBlock.blockNumber), field("Block hash", data.sourceBlock.blockHash),
      integer("Nonce", m.nonce), integer("Destination domain", m.destinationDomain), field("Destination Gateway", m.destinationGateway), field("Receiver", m.destinationReceiver)],
      { details: [{ title: "Public payload and source occurrences", fields: [field("Payload (hex)", m.payload), field("Payload hash", m.payloadHash)],
        records: data.sourceOccurrences.map(value => ({ title: "Source occurrence", status: value.status, fields: [field("Transaction hash", value.transactionHash),
          integer("Log index", value.logIndex), integer("Block number", value.blockNumber), field("Block hash", value.blockHash), field("Reorged at", value.reorgedAt)] })) }] }),
    section("authorization", "ZK Authorization", authLabel, [field("Observed result", a?.status ?? "UNAVAILABLE"), field("Application", a?.application),
      field("Basis", a?.basis), field("Transaction hash", a?.transactionHash), field("Source block hash", a?.blockHash)],
      { note: "Authorization is observed from the configured production IdentityApplicationA → SourceGateway path for this occurrence. No proof is reverified here; current credential status is not inferred." }),
    section("finality", "Finality", f.status, [field("Source lifecycle", f.status), integer("Required depth", f.requiredDepth),
      field("Finalizing at", f.finalizingAt), field("Finalized at", f.finalizedAt), integer("Finalized at head", f.finalizedAtHead), field("Reorged at", f.reorgedAt)],
      { note: "Source finality and destination execution are separate observations." }),
    section("batch", "Batch", b?.status ?? (reorged ? "Not reached" : "Not batched yet"), b ? [field("Batch ID", b.batchId), integer("Batch epoch", b.batchEpoch),
      field("Status", b.status), integer("Position", b.position), integer("Member count", b.memberCount), integer("Source domain", b.sourceDomain), field("SourceGateway", b.sourceGateway)] : []),
    section("merkle", "Merkle Commitment", data.merkle ? "Persisted commitment" : "No sealed commitment yet", data.merkle ?
      [field("Message Root", data.merkle.root), integer("Position", data.merkle.position), integer("Member count", data.merkle.memberCount),
        field("Proof path", data.merkle.siblings == null ? "Not available yet" : "Available in persisted delivery evidence")] : [],
      { details: data.merkle?.siblings == null ? [] : [{ title: "Merkle siblings", fields: list(data.merkle.siblings).map((value, index) => field(`Sibling ${index}`, hashField(value))) }] }),
    section("consensus", "PBFT Consensus", p?.status ?? "Not reached", p ? [field("Status", p.status), field("Protocol version", p.protocolVersion),
      integer("Pinned validator epoch", p.validatorEpoch), integer("View", p.view), field("Committee digest", p.committeeDigest), field("Primary", p.primary),
      field("Committee size", p.committeeSize), field("Quorum threshold", p.quorum)] : []),
    section("votes", "Validator Votes", `${votes.length} persisted vote records`, [], { records: votes,
      details: [{ title: "Committee member observations", records: (p?.observations == null ? [] : list(p.observations)).map(value => ({ title: value.validator,
        status: value.ownCommit ? "Own COMMIT observed" : "No own COMMIT observed", fields: [field("Member", value.validator),
          field("Local status", value.status), integer("Evidence view", value.view), integer("Current local view", value.currentView),
          field("Own PREPARE", value.ownPrepare), field("Own COMMIT", value.ownCommit)] })) }] }),
    section("quorum", "Quorum & Certificate", q ? "Canonical QC persisted" : "No quorum certificate yet", [
      field("Required quorum", p?.quorum == null || p?.committeeSize == null ? null : `${p.quorum} / ${p.committeeSize} required`),
      field("Observed COMMIT signers", String(commits.size)), ...(q ? [field("QC version", q.protocolVersion), integer("Validator epoch", q.validatorEpoch),
        integer("View", q.view), field("Committee digest", q.committeeDigest), field("Message Root", q.messageRoot), field("QC digest", q.qcDigest),
        field("QC quorum", q.quorum), field("Actual QC signers", list(q.signers).join("\n"))] : [])]),
    section("delivery", "Delivery", data.delivery?.status ?? "Not reached", data.delivery ? [field("Job ID", data.delivery.deliveryJobId),
      field("Status", data.delivery.status), field("Destination Gateway", data.delivery.destinationGateway), field("Receiver", data.delivery.destinationReceiver),
      field("Worker", data.delivery.ownership?.workerId), integer("Fencing token", data.delivery.ownership?.fencingToken),
      field("Lease expires at", data.delivery.ownership?.expiresAt), field("Lease released at", data.delivery.ownership?.releasedAt),
      field("Intent state", data.delivery.intent?.status), integer("Transaction nonce", data.delivery.intent?.nonce),
      field("Retry at", data.delivery.intent?.retryAt), field("Retry stop reason", data.delivery.intent?.retryStopReason)] : []),
    section("attempts", "Relayer Attempts", attempts.length ? `${attempts.length} persisted attempts` : "No signed attempts yet", [], { records: attempts }),
    section("destination", "Destination Transaction", d?.state ?? "Not reached", d ? [field("State", d.state), field("Canonicality", d.canonicality),
      field("Current canonical transaction", d.transactionHash), field("Latest candidate transaction", d.candidateTransactionHash), integer("Nonce", d.nonce),
      integer("Current block number", d.blockNumber), field("Current block hash", d.blockHash), integer("Confirmed head", d.confirmedHead),
      integer("Observed confirmations", d.observedConfirmations), integer("Required depth", d.requiredDepth)] : [],
      { note: "The latest candidate can differ from the current winner. Archived orphan receipts appear only in attempt history. GET never reconciles a reorg." }),
    section("execution", "Execution Result", executionLabel, [field("Current result", e?.status ?? "NOT_EXECUTED"), field("Basis", e?.basis),
      field("Gateway call", e?.gatewayCall), field("Receiver", m.destinationReceiver), field("Application business result", e?.businessResult)],
      { note: "Persisted Gateway execution is distinct from transport inclusion. Application-specific business state is not queried or inferred by this page." }),
  ];
  const step = (id, label, state, status) => ({ id, label, state, status });
  const downstream = (state, status) => reorged ? ["not-reached", "Not reached"] : [state, status];
  const timeline = [step("source", "Source", reorged ? "reorged" : "complete", reorged ? "REORGED" : "OBSERVED"),
    step("finality", "Finality", reorged ? "reorged" : f.status === "FINALIZED" ? "complete" : "current", f.status),
    step("authorization", "Authorization", reorged ? "historical" : a?.status === "AUTHORIZED" ? "complete" : "pending", a?.status ?? "UNAVAILABLE"),
    step("batch", "Batch", ...downstream(b?.batchId ? "complete" : b ? "current" : "pending", b?.status ?? "Not reached")),
    step("consensus", "Consensus", ...downstream(q ? "complete" : p ? "current" : "pending", p?.status ?? "Not reached")),
    step("delivery", "Delivery", ...downstream(attempts.length ? "complete" : data.delivery ? "current" : "pending", data.delivery?.intent?.status ?? data.delivery?.status ?? "Not reached")),
    step("destination", "Destination", ...downstream(d?.transactionHash ? "complete" : d ? "current" : "pending", d?.state ?? "Not reached")),
    step("execution", "Execution", ...downstream(e?.status === "CONFIRMED" ? "complete" : e?.status === "REVERTED" ? "failed" : e ? "current" : "pending", e?.status ?? "Not executed"))];
  return { messageId: m.messageId, status: reorged ? "REORGED" : e?.status ?? p?.status ?? b?.status ?? f.status,
    observedAt: text(data.observedAt), summary: [integer("Source domain", m.sourceDomain), integer("Destination domain", m.destinationDomain),
      field("Sender", m.sourceSender), field("Receiver", m.destinationReceiver), integer("Nonce", m.nonce), integer("Deadline (Unix seconds)", m.deadline)],
    timeline, sections };
}
