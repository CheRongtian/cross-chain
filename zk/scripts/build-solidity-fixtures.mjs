import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { groth16 } from "snarkjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ZK_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = path.resolve(ZK_ROOT, "..");
const PROVING_DIR = path.join(ZK_ROOT, "build", "proving");
const GENERATED_CONTRACTS_DIR = path.join(PROJECT_ROOT, "contracts", "generated");
const CALLDATA_DIR = path.join(PROVING_DIR, "solidity-calldata");
const PROOF_PATH = path.join(PROVING_DIR, "proof.json");
const PUBLIC_PATH = path.join(PROVING_DIR, "public.json");
const FIXTURE_PATH = path.join(GENERATED_CONTRACTS_DIR, "CredentialProofFixture.sol");
const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function incrementField(value, modulus) {
  return `0x${((BigInt(value) + 1n) % modulus).toString(16).padStart(64, "0")}`;
}

function formatArray(value) {
  if (Array.isArray(value)) {
    return `[${value.map(formatArray).join(",")}]`;
  }
  return value;
}

function solidityFixture(proofA, proofB, proofC, publicSignals) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Generated from snarkjs Solidity calldata for local verification.
library CredentialProofFixture {
    function proofA() internal pure returns (uint256[2] memory value) {
        value[0] = uint256(${proofA[0]});
        value[1] = uint256(${proofA[1]});
    }

    function proofB() internal pure returns (uint256[2][2] memory value) {
        value[0][0] = uint256(${proofB[0][0]});
        value[0][1] = uint256(${proofB[0][1]});
        value[1][0] = uint256(${proofB[1][0]});
        value[1][1] = uint256(${proofB[1][1]});
    }

    function proofC() internal pure returns (uint256[2] memory value) {
        value[0] = uint256(${proofC[0]});
        value[1] = uint256(${proofC[1]});
    }

    function publicSignals() internal pure returns (uint256[4] memory value) {
        value[0] = uint256(${publicSignals[0]});
        value[1] = uint256(${publicSignals[1]});
        value[2] = uint256(${publicSignals[2]});
        value[3] = uint256(${publicSignals[3]});
    }
}
`;
}

async function writeCalldata(name, proofA, proofB, proofC, publicSignals) {
  const lines = [
    formatArray(proofA),
    formatArray(proofB),
    formatArray(proofC),
    ...publicSignals,
  ];
  const outputPath = path.join(CALLDATA_DIR, `${name}.txt`);
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Prepared Solidity calldata: ${path.relative(PROJECT_ROOT, outputPath)}`);
}

async function main() {
  const proof = await loadJson(PROOF_PATH);
  const publicSignalsFromProof = await loadJson(PUBLIC_PATH);
  const exported = await groth16.exportSolidityCallData(proof, publicSignalsFromProof);
  const [proofA, proofB, proofC, publicSignals] = JSON.parse(`[${exported}]`);

  requireCondition(Array.isArray(proofA) && proofA.length === 2, "invalid Solidity proof A");
  requireCondition(
    Array.isArray(proofB) && proofB.length === 2 && proofB.every((row) => Array.isArray(row) && row.length === 2),
    "invalid Solidity proof B",
  );
  requireCondition(Array.isArray(proofC) && proofC.length === 2, "invalid Solidity proof C");
  requireCondition(Array.isArray(publicSignals) && publicSignals.length === 4, "expected four public signals");

  await mkdir(GENERATED_CONTRACTS_DIR, { recursive: true });
  await mkdir(CALLDATA_DIR, { recursive: true });
  await writeFile(FIXTURE_PATH, solidityFixture(proofA, proofB, proofC, publicSignals), "utf8");
  console.log(`Prepared Solidity proof fixture: ${path.relative(PROJECT_ROOT, FIXTURE_PATH)}`);

  await writeCalldata("valid", proofA, proofB, proofC, publicSignals);

  const tamperedProofA = clone(proofA);
  tamperedProofA[0] = incrementField(tamperedProofA[0], BASE_FIELD);
  await writeCalldata("tampered-proof", tamperedProofA, proofB, proofC, publicSignals);

  const publicCases = [
    ["wrong-credential-commitment", 0],
    ["wrong-trusted-issuer", 1],
    ["wrong-required-role", 2],
    ["wrong-current-timestamp", 3],
  ];

  for (const [name, index] of publicCases) {
    const modifiedSignals = clone(publicSignals);
    modifiedSignals[index] = incrementField(modifiedSignals[index], SCALAR_FIELD);
    await writeCalldata(name, proofA, proofB, proofC, modifiedSignals);
  }
}

await main();
