import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const SOURCE_PATH = path.join(PROJECT_ROOT, "test-vectors", "canonical-messages.json");
const BUILD_PATH = path.join(PROJECT_ROOT, "zk", "build", "canonical-message-vector.json");
const SOLIDITY_PATH = path.join(PROJECT_ROOT, "contracts", "generated", "CanonicalMessageVector.sol");

function cast(...args) {
  return execFileSync("cast", args, { encoding: "utf8" }).trim();
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function solidityAddress(value) {
  requireCondition(/^0x[0-9a-fA-F]{40}$/.test(value), `invalid vector address: ${value}`);
  return value;
}

const source = JSON.parse(await readFile(SOURCE_PATH, "utf8"));
const vector = source.vectors?.[0];

requireCondition(source.vectorVersion === 2, "unsupported canonical message vector version");
requireCondition(vector !== undefined, "canonical message vector is missing");
requireCondition(vector.expectedMessageId === "generated-by-scripts/build-canonical-message-vector.mjs", "unexpected expectedMessageId source");

const payloadHash = cast("keccak", vector.payload);
requireCondition(payloadHash.toLowerCase() === vector.payloadHash.toLowerCase(), "payload hash does not match the vector");

const encoded = cast(
  "abi-encode",
  "f(uint8,uint256,address,address,uint256,address,uint256,bytes32,uint256)",
  String(vector.version),
  String(vector.sourceDomain),
  vector.sourceGateway,
  vector.sourceSender,
  String(vector.destinationDomain),
  vector.destinationReceiver,
  String(vector.nonce),
  payloadHash,
  String(vector.deadline),
);
const expectedMessageId = cast("keccak", encoded);
const generated = { ...source, vectors: [{ ...vector, expectedMessageId }] };

await mkdir(path.dirname(BUILD_PATH), { recursive: true });
await mkdir(path.dirname(SOLIDITY_PATH), { recursive: true });
await writeFile(BUILD_PATH, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
await writeFile(
  SOLIDITY_PATH,
  `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library CanonicalMessageVector {
    function version() internal pure returns (uint8) { return ${vector.version}; }
    function sourceDomain() internal pure returns (uint256) { return ${vector.sourceDomain}; }
    function sourceGateway() internal pure returns (address) { return ${solidityAddress(vector.sourceGateway)}; }
    function sourceSender() internal pure returns (address) { return ${solidityAddress(vector.sourceSender)}; }
    function destinationDomain() internal pure returns (uint256) { return ${vector.destinationDomain}; }
    function destinationReceiver() internal pure returns (address) { return ${solidityAddress(vector.destinationReceiver)}; }
    function nonce() internal pure returns (uint256) { return ${vector.nonce}; }
    function payloadHash() internal pure returns (bytes32) { return ${payloadHash}; }
    function deadline() internal pure returns (uint256) { return ${vector.deadline}; }
    function expectedMessageId() internal pure returns (bytes32) { return ${expectedMessageId}; }
}
`,
  "utf8",
);

console.log(`Prepared canonical message vector: ${path.relative(PROJECT_ROOT, BUILD_PATH)}`);
console.log(`Prepared Solidity canonical message fixture: ${path.relative(PROJECT_ROOT, SOLIDITY_PATH)}`);
