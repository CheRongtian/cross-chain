import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { encodeAbiParameters, hashMessage, keccak256, parseAbiParameters, recoverMessageAddress,
  stringToHex } from "viem";
import { validatorAccount } from "../src/identity.mjs";
import { developmentKeys } from "../test/helpers/fixtures.mjs";
import { deliveryFixture, deliveryMessage } from "../../indexer/test/helpers/delivery-fixtures.mjs";
import { buildMessageBatch } from "../../indexer/src/message-batch.mjs";
import { buildMessageMerkleTree } from "../../indexer/src/message-merkle.mjs";
import { createValidatorSetResolver } from "../src/validator-sets.mjs";
import { encodeCertificate } from "../test/helpers/pbft-certificate.mjs";

const target = new URL("../../test-vectors/pbft-certificates.json", import.meta.url);
const committeeVector = JSON.parse(readFileSync(new URL("../../test-vectors/validator-sets.json", import.meta.url), "utf8"));
const history = committeeVector.history.map(({ canonicalValidators, ...entry }, index) => ({
  ...entry, validators: canonicalValidators, activationBatchEpoch: index === 0 ? "0" : "24",
}));
const resolver = createValidatorSetResolver(history);
const accounts = developmentKeys(5).map(validatorAccount);
const accountByAddress = new Map(accounts.map((account) => [account.address.toLowerCase(), account]));
const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// Independent reference type strings and ABI layouts. Never import production digest builders here.
function typeFor(kind, version) {
  const common = `uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch${version === "1" ? "" : ",uint256 view"},bytes32 batchId,bytes32 messageRoot`;
  if (kind === "proposal") return `PBFTPrePrepare(${common},address primaryIdentity${version === "3" ? ",uint256 validatorEpoch,bytes32 committeeDigest" : ""})`;
  return `${kind === "commit" ? "PBFTCommit" : "PBFTQuorumCertificate"}(${common},bytes32 proposalDigest,bytes32 committeeDigest${kind === "commit" ? ",address voterIdentity" : ""}${version === "3" ? ",uint256 validatorEpoch" : ""})`;
}

function referenceDigest(kind, statement, identity) {
  const version = statement.protocolVersion;
  const parameters = ["bytes32", "uint8", "uint256", "address", "uint256"];
  const values = [keccak256(stringToHex(typeFor(kind, version))), Number(version), BigInt(statement.sourceDomain),
    statement.sourceGateway, BigInt(statement.epoch)];
  if (version !== "1") { parameters.push("uint256"); values.push(BigInt(statement.view)); }
  parameters.push("bytes32", "bytes32"); values.push(statement.batchId, statement.messageRoot);
  if (kind === "proposal") {
    parameters.push("address"); values.push(identity);
  } else {
    parameters.push("bytes32", "bytes32"); values.push(statement.proposalDigest, statement.committeeDigest);
    if (kind === "commit") { parameters.push("address"); values.push(identity); }
  }
  if (version === "3") {
    parameters.push("uint256"); values.push(BigInt(statement.validatorEpoch));
    if (kind === "proposal") { parameters.push("bytes32"); values.push(statement.committeeDigest); }
  }
  return keccak256(encodeAbiParameters(parseAbiParameters(parameters.join(",")), values));
}

function changeSignature(signature, mode) {
  const recovery = Number.parseInt(signature.slice(-2), 16) - 27;
  if (mode === "v01") return `${signature.slice(0, -2)}${recovery.toString(16).padStart(2, "0")}`;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  return `${signature.slice(0, 66)}${(order - s).toString(16).padStart(64, "0")}${(27 + (recovery ^ 1)).toString(16)}`;
}

async function vote(statement, address, mode = "standard") {
  const account = accountByAddress.get(address);
  const commitDigest = referenceDigest("commit", statement, address);
  const message = { raw: commitDigest };
  let signature = mode === "raw" ? await account.sign({ hash: commitDigest }) :
    await account.signMessage({ message: mode === "double" ? { raw: hashMessage(message) } : message });
  if (mode === "v01" || mode === "highS") signature = changeSignature(signature, mode);
  return { ...statement, messageType: "COMMIT", voterIdentity: address, commitDigest, signature };
}

async function generate() {
  const fixture = await deliveryFixture({ epoch: 23n, validatorSets: resolver });
  const cases = [];
  async function add(name, version, count, { rotated = false, view = "0", mode = "standard", boundary = false } = {}) {
    const set = history[rotated ? 1 : 0];
    const epoch = boundary ? ((1n << 256n) - 1n).toString() : rotated ? "24" : "23";
    const sourceDomain = boundary ? ((1n << 200n) + 10011n).toString() : "10011";
    const batch = buildMessageBatch({ sourceDomain: BigInt(sourceDomain), sourceGateway: fixture.record.sourceGateway,
      epoch: BigInt(epoch), messages: Array.from({ length: 3 }, (_, index) => deliveryMessage(index, { sourceDomain: BigInt(sourceDomain) })) });
    const tree = buildMessageMerkleTree(batch);
    const statement = { protocolVersion: version, sourceDomain,
      sourceGateway: fixture.record.sourceGateway, epoch,
      ...(version !== "1" ? { view: boundary ? ((1n << 256n) - 1n).toString() : view } : {}),
      batchId: batch.batchId, messageRoot: tree.messageRoot,
      committeeDigest: set.committeeDigest, ...(version === "3" ? { validatorEpoch: set.validatorEpoch } : {}) };
    const primary = set.validators[Number((BigInt(epoch) + BigInt(statement.view ?? "0")) % 4n)];
    statement.proposalDigest = referenceDigest("proposal", statement, primary);
    const commits = await Promise.all(set.validators.slice(0, count).map((address) => vote(statement, address, mode)));
    const certificate = { messageType: "QUORUM_CERTIFICATE", ...statement, qcDigest: referenceDigest("qc", statement), commits };
    const expected = { protocolVersion: version, sourceDomain: statement.sourceDomain, sourceGateway: statement.sourceGateway,
      batchEpoch: epoch, view: statement.view ?? "0", batchId: statement.batchId, messageRoot: statement.messageRoot,
      authorityEpoch: set.validatorEpoch };
    const recovered = await Promise.all(commits.map((entry) => recoverMessageAddress({
      message: { raw: entry.commitDigest }, signature: entry.signature,
    }).then((address) => address.toLowerCase())));
    assert.deepEqual(recovered, commits.map((entry) => entry.voterIdentity));
    cases.push({ name, valid: true, expected, certificate, encoded: encodeCertificate(certificate),
      proposalType: typeFor("proposal", version), commitType: typeFor("commit", version), qcType: typeFor("qc", version),
      primary, signingDigests: commits.map((entry) => hashMessage({ raw: entry.commitDigest })), recovered });
  }
  for (const version of ["1", "2", "3"]) {
    for (const count of [3, 4]) await add(`v${version}-quorum-${count}`, version, count);
  }
  await add("v2-view", "2", 3, { view: "9" });
  await add("v3-rotated-quorum-3", "3", 3, { rotated: true, view: "1" });
  await add("v3-rotated-quorum-4", "3", 4, { rotated: true, view: "1" });
  await add("v3-uint256-boundary", "3", 3, { rotated: true, boundary: true });
  await add("v3-v-0-1", "3", 3, { mode: "v01" });
  await add("v3-high-s", "3", 3, { mode: "highS" });

  const base = cases.find((entry) => entry.name === "v3-quorum-3");
  function negative(name, change, source = base) {
    const entry = structuredClone(source);
    entry.name = name; entry.valid = false;
    delete entry.recovered;
    change(entry);
    entry.encoded = encodeCertificate(entry.certificate);
    entry.signingDigests = entry.certificate.commits.map((item) => hashMessage({ raw: item.commitDigest }));
    cases.push(entry);
  }
  for (const mode of ["raw", "double"]) {
    const commits = await Promise.all(base.certificate.commits.map((entry) => vote(base.certificate, entry.voterIdentity, mode)));
    // Copy only the statement fields into each COMMIT, excluding QC/evidence keys.
    for (const entry of commits) { delete entry.commits; delete entry.qcDigest; }
    negative(`${mode}-digest-signing`, (entry) => { entry.certificate.commits = commits; });
  }
  const outsider = await vote(base.certificate, committeeVector.directory[4]);
  delete outsider.commits; delete outsider.qcDigest;
  negative("nonmember-signer", (entry) => {
    entry.certificate.commits[2] = outsider;
    entry.certificate.commits.sort((a, b) => a.voterIdentity < b.voterIdentity ? -1 : 1);
  });
  negative("duplicate-recovered-signer", (entry) => {
    entry.certificate.commits[1] = structuredClone(entry.certificate.commits[0]);
    entry.certificate.commits[1].signature = changeSignature(entry.certificate.commits[1].signature, "highS");
  });
  negative("noncanonical-signer-order", (entry) => { entry.certificate.commits.reverse(); });
  negative("insufficient-evidence", (entry) => { entry.certificate.commits.pop(); });
  negative("claimed-signer-mismatch", (entry) => { entry.certificate.commits[0].signature = entry.certificate.commits[1].signature; });
  negative("bad-extra-evidence", (entry) => { entry.certificate.commits[3].signature = `0x${"00".repeat(65)}`; },
    cases.find((entry) => entry.name === "v3-quorum-4"));
  negative("wrong-commit-digest", (entry) => { entry.certificate.commits[0].commitDigest = `0x${"ab".repeat(32)}`; });
  negative("wrong-qc-digest", (entry) => { entry.certificate.qcDigest = `0x${"ab".repeat(32)}`; });
  negative("wrong-proposal-digest", (entry) => { entry.certificate.proposalDigest = `0x${"ab".repeat(32)}`; });
  negative("wrong-committee-digest", (entry) => { entry.certificate.committeeDigest = history[1].committeeDigest; });
  negative("wrong-trusted-root", (entry) => { entry.expected.messageRoot = `0x${"ab".repeat(32)}`; });
  negative("cross-epoch-context", (entry) => { entry.expected.authorityEpoch = history[1].validatorEpoch; });
  negative("legacy-downgrade", (entry) => { entry.expected.protocolVersion = "3"; }, cases[0]);
  negative("legacy-wrong-authority", (entry) => { entry.expected.authorityEpoch = history[1].validatorEpoch; }, cases[0]);
  return { format: "PBFTCertificateGoldenVectors", transportAbi: "uint8,bytes,bytes32,(address voterIdentity,bytes32 commitDigest,bytes signature)[]",
    signatureScheme: "EIP-191 raw 32-byte COMMIT digest; 65 bytes; v=0/1/27/28; high-s accepted",
    history, caseCount: cases.length, cases };
}

const args = process.argv.slice(2);
assert.ok(args.length === 1 && ["--write", "--check"].includes(args[0]), "Use --write once or --check for frozen evidence");
const generated = `${JSON.stringify(await generate(), null, 2)}\n`;
if (args[0] === "--write") {
  assert.equal(existsSync(target), false, "Refusing to overwrite frozen PBFT certificate vectors");
  writeFileSync(target, generated, { flag: "wx" });
  console.log("Frozen public PBFT certificate vectors created; no private keys stored.");
} else {
  assert.equal(readFileSync(target, "utf8"), generated, "Frozen PBFT certificate bytes or reference digests drifted");
  console.log("VALID: frozen PBFT certificate vectors match the independent reference encoder and signing semantics");
}
