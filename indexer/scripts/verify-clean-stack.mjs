import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { localConfiguration } from "./local/config.mjs";
import { demonstrateLocalStack,ensureLocalExplorerMessage,startLocalStack,stopLocalStack } from "./local/main.mjs";
import { jsonText,safeError } from "./local/tools.mjs";

console.log("[clean-stack privacy demonstration]");
console.log("Fresh owned PostgreSQL, independent chains/namespaces/ports, real workers and unchanged observation assets");
let stack;
let configuration;
try {
  configuration = await localConfiguration({ isolated: true });
  stack = await startLocalStack(configuration);
  const validators = stack.manifest.components.filter(value => value.name.startsWith("validator-"));
  assert.equal(validators.length,4); assert.equal(new Set(validators.map(value => value.pid)).size,4);
  console.log("Independent validator processes: " + jsonText(validators.map((value,index) => ({ ...value,
    address: stack.manifest.peers[index].address,schema: stack.manifest.validatorSchemas[index],endpoint: stack.manifest.peers[index].url }))));
  console.log("VALID: fresh chains, empty migrated source state, independent validator stores, both leased Relayers and ten healthy observation targets are ready");
  const first = await ensureLocalExplorerMessage(stack);
  console.log(jsonText(first));
  const reused = await ensureLocalExplorerMessage(stack);
  assert.deepEqual(reused,first);
  console.log("VALID: startup message preparation follows the real happy path and reuses its live API-confirmed result without another source message");
  // Prove a second run needs no previous message ID, proof, supplier or QC.
  const second = await demonstrateLocalStack(stack.record);
  assert.notEqual(second.messageId,first.messageId); assert.notEqual(second.supplier,first.supplier);
  assert.notEqual(second.batchId,first.batchId); assert.notEqual(second.destinationTransaction,first.destinationTransaction);
  console.log(jsonText(second));
  if (process.env.LOCAL_VERIFICATION_OWNER_FILE) console.log("Owned clean stack retained for the immediately following fault demonstrations; root cleanup retains ownership");
} catch (error) {
  console.error(safeError(error)); process.exitCode = 1;
  // Component stderr belongs in the root tee log as well as the run directory.
  // The private prover directory is deliberately excluded from public output.
  if (configuration) {
    try {
      const directory = join(configuration.directory,"logs");
      for (const name of await readdir(directory)) {
        if (!name.endsWith(".log")) continue;
        console.error(`[clean-stack component: ${name}]`);
        console.error(safeError({ message: await readFile(join(directory,name),"utf8") }));
      }
    } catch (diagnosticError) { if (diagnosticError.code !== "ENOENT") console.error("Component diagnostics unavailable: " + safeError(diagnosticError)); }
  }
}
finally {
  if (stack && (process.exitCode || !process.env.LOCAL_VERIFICATION_OWNER_FILE)) {
    try { await stopLocalStack(stack.record); }
    catch (error) { console.error("Clean-stack cleanup failed: " + safeError(error)); process.exitCode = 1; }
  }
}
if (!process.exitCode) console.log("CLEAN BOOTSTRAP / HAPPY-PATH / PRIVACY DEMONSTRATION PASSED");
