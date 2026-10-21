import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertLocalOwnership,demonstrateLocalStack,stopLocalStack } from "./local/main.mjs";
import { ROOT,jsonText,processIdentity,readJson,safeError,waitFor } from "./local/tools.mjs";

console.log("[byzantine and validator crash demonstrations]");
let record;
try {
  if (!process.env.LOCAL_VERIFICATION_OWNER_FILE) throw new Error("Root verification must hand off its existing owned clean stack");
  record = assertLocalOwnership(await readJson(process.env.LOCAL_VERIFICATION_OWNER_FILE));
  assert.equal(record.parent,join(ROOT,".run/verification"),"fault verification must not reuse a manually running product stack");
  const manifest = await readJson(join(record.directory,"manifest.json"));
  assert.equal(manifest.isolated,true); assert.equal(manifest.ready,true);
  const previous = await readJson(join(record.directory,"demo-result.json"));
  const byzantine = await demonstrateLocalStack(record,console.log,"byzantine-validator");
  console.log(jsonText(byzantine));
  const crash = await demonstrateLocalStack(record,console.log,"validator-crash");
  console.log(jsonText(crash));
  for (const field of ["messageId","supplier","batchId","destinationTransaction"]) {
    assert.equal(new Set([previous[field],byzantine[field],crash[field]]).size,3,`each demonstration needs independent ${field}`);
  }
  for (const result of [byzantine,crash]) {
    assert.equal(result.fault.readyValidators,4); assert.equal(result.fault.committeeSize,4); assert.equal(result.fault.quorum,3);
    assert.equal(result.fault.honestSigners.length,3); assert.ok(!result.fault.honestSigners.includes(result.fault.target));
    assert.equal(result.privacy,"PASSED"); assert.equal(result.messageExecuted,true); assert.equal(result.supplierVerified,true);
  }
} catch (error) {
  console.error(safeError(error)); process.exitCode = 1;
  if (record) {
    try {
      const logs = join(record.directory,"logs");
      for (const name of await readdir(logs)) if (name.endsWith(".log")) {
        console.error(`[fault demonstration component: ${name}]`);
        console.error(safeError({ message: await readFile(join(logs,name),"utf8") }));
      }
    } catch (diagnosticError) { console.error("Component diagnostics unavailable: " + safeError(diagnosticError)); }
  }
} finally {
  if (record) {
    try {
      await stopLocalStack(record);
      const owned = [record.supervisor,...await readJson(join(record.directory,"processes.json"))];
      await waitFor("all fault demonstration processes stopped",async () => {
        for (const value of owned) if (await processIdentity(value.pid) === value.identity) return false;
        return true;
      },{ timeout: 10000,retryErrors: false });
      const manifest = await readJson(join(record.directory,"manifest.json"));
      assert.equal(manifest.ready,false); assert.ok(manifest.stoppedAt);
    }
    catch (error) { console.error("Fault demonstration cleanup failed: " + safeError(error)); process.exitCode = 1; }
  }
}
if (!process.exitCode) console.log("BYZANTINE / VALIDATOR CRASH DEMONSTRATIONS PASSED");
