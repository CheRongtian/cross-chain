import { readFile, writeFile } from "node:fs/promises";
import { CREDENTIAL_PUBLIC_SIGNAL_ORDER } from "../../indexer/src/forward-authorization.mjs";

const [inputPath, outputPath, scalarFieldPrime] = process.argv.slice(2);

if (!inputPath || !outputPath || !scalarFieldPrime) {
  throw new Error("usage: node tamper-public.mjs <public.json> <output.json> <scalar-field-prime>");
}

const publicSignals = JSON.parse(await readFile(inputPath, "utf8"));

if (!Array.isArray(publicSignals) || publicSignals.length !== CREDENTIAL_PUBLIC_SIGNAL_ORDER.length) {
  throw new Error(
    "expected eleven public signals with forwarding intent hi/lo appended after nullifier",
  );
}

const prime = BigInt(scalarFieldPrime);
publicSignals[0] = ((BigInt(publicSignals[0]) + 1n) % prime).toString();

await writeFile(outputPath, `${JSON.stringify(publicSignals, null, 2)}\n`, "utf8");
console.log(`Tampered credential commitment in ${outputPath}`);
