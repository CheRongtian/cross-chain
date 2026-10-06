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

const EXPECTED_MESSAGE_TYPE =
  "CrossChainMessage(uint8 version,uint256 sourceDomain,address sourceGateway,address sourceSender,uint256 destinationDomain,address destinationGateway,address destinationReceiver,uint256 nonce,bytes32 payloadHash,uint256 deadline)";
const GENERATED_MARKER = "generated-by-scripts/build-canonical-message-vector.mjs";
const CANONICAL_FIELDS = [
  "version",
  "sourceDomain",
  "sourceGateway",
  "sourceSender",
  "destinationDomain",
  "destinationGateway",
  "destinationReceiver",
  "nonce",
  "payloadHash",
  "deadline",
];
const REQUIRED_SEPARATION_FIELDS = [
  "sourceDomain",
  "sourceGateway",
  "destinationDomain",
  "destinationGateway",
];

const source = JSON.parse(await readFile(SOURCE_PATH, "utf8"));
const vectors = source.vectors ?? [];

requireCondition(source.vectorVersion === 3, "unsupported canonical message vector version");
requireCondition(source.messageType === EXPECTED_MESSAGE_TYPE, "canonical message type does not match the protocol schema");
requireCondition(vectors.length === 5, "canonical message vectors must contain one base and four domain variants");

const messageTypeHash = cast("keccak", source.messageType);
const generatedVectors = vectors.map((vector) => {
  requireCondition(vector.expectedMessageId === GENERATED_MARKER, `unexpected expectedMessageId source for ${vector.name}`);
  solidityAddress(vector.sourceGateway);
  solidityAddress(vector.sourceSender);
  solidityAddress(vector.destinationGateway);
  solidityAddress(vector.destinationReceiver);

  const payloadHash = cast("keccak", vector.payload);
  requireCondition(
    payloadHash.toLowerCase() === vector.payloadHash.toLowerCase(),
    `payload hash does not match vector ${vector.name}`,
  );

  const encoded = cast(
    "abi-encode",
    "f(bytes32,uint8,uint256,address,address,uint256,address,address,uint256,bytes32,uint256)",
    messageTypeHash,
    String(vector.version),
    String(vector.sourceDomain),
    vector.sourceGateway,
    vector.sourceSender,
    String(vector.destinationDomain),
    vector.destinationGateway,
    vector.destinationReceiver,
    String(vector.nonce),
    payloadHash,
    String(vector.deadline),
  );

  return { ...vector, payloadHash, expectedMessageId: cast("keccak", encoded) };
});

const baseVector = generatedVectors[0];
for (const separationField of REQUIRED_SEPARATION_FIELDS) {
  const variant = generatedVectors.find((vector) => vector.differenceFromBase === separationField);
  requireCondition(variant !== undefined, `missing ${separationField} separation vector`);

  const differences = CANONICAL_FIELDS.filter(
    (field) => String(variant[field]).toLowerCase() !== String(baseVector[field]).toLowerCase(),
  );
  requireCondition(
    differences.length === 1 && differences[0] === separationField,
    `${variant.name} must differ from the base only by ${separationField}`,
  );
}

requireCondition(
  new Set(generatedVectors.map((vector) => vector.expectedMessageId.toLowerCase())).size === generatedVectors.length,
  "domain-separated vectors produced duplicate message IDs",
);

const generated = { ...source, messageTypeHash, vectors: generatedVectors };
const solidityVectors = generatedVectors
  .map(
    (vector, index) => `        if (index == ${index}) {
            return Vector({
                version: ${vector.version},
                sourceDomain: ${vector.sourceDomain},
                sourceGateway: ${solidityAddress(vector.sourceGateway)},
                sourceSender: ${solidityAddress(vector.sourceSender)},
                destinationDomain: ${vector.destinationDomain},
                destinationGateway: ${solidityAddress(vector.destinationGateway)},
                destinationReceiver: ${solidityAddress(vector.destinationReceiver)},
                nonce: ${vector.nonce},
                payloadHash: ${vector.payloadHash},
                deadline: ${vector.deadline},
                expectedMessageId: ${vector.expectedMessageId}
            });
        }`,
  )
  .join("\n\n");

await mkdir(path.dirname(BUILD_PATH), { recursive: true });
await mkdir(path.dirname(SOLIDITY_PATH), { recursive: true });
await writeFile(BUILD_PATH, `${JSON.stringify(generated, null, 2)}\n`, "utf8");
await writeFile(
  SOLIDITY_PATH,
  `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library CanonicalMessageVector {
    error InvalidVectorIndex();

    struct Vector {
        uint8 version;
        uint256 sourceDomain;
        address sourceGateway;
        address sourceSender;
        uint256 destinationDomain;
        address destinationGateway;
        address destinationReceiver;
        uint256 nonce;
        bytes32 payloadHash;
        uint256 deadline;
        bytes32 expectedMessageId;
    }

    function messageTypeHash() internal pure returns (bytes32) { return ${messageTypeHash}; }
    function length() internal pure returns (uint256) { return ${generatedVectors.length}; }

    function vectorAt(uint256 index) internal pure returns (Vector memory) {
${solidityVectors}

        revert InvalidVectorIndex();
    }
}
`,
  "utf8",
);

console.log(`Prepared canonical message vector: ${path.relative(PROJECT_ROOT, BUILD_PATH)}`);
console.log(`Prepared Solidity canonical message fixture: ${path.relative(PROJECT_ROOT, SOLIDITY_PATH)}`);
