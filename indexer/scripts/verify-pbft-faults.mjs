import assert from "node:assert/strict";
import { join } from "node:path";
import { demonstrateLocalStack } from "./local/main.mjs";
import { jsonText,readJson,safeError } from "./local/tools.mjs";
import { componentDiagnostics,stopVerificationStack,verificationStack } from "./local/verification.mjs";

console.log("[byzantine and validator crash demonstrations]");
let record;
try {
  record = await verificationStack();
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
  console.log("Owned clean stack retained for the immediately following relayer/reorg/replay/recovery demonstrations; root cleanup retains ownership");
} catch (error) {
  console.error(safeError(error)); process.exitCode = 1;
  if (record) await componentDiagnostics(record);
} finally {
  if (record && process.exitCode) {
    try { await stopVerificationStack(record); }
    catch (error) { console.error("Fault demonstration cleanup failed: " + safeError(error)); process.exitCode = 1; }
  }
}
if (!process.exitCode) console.log("BYZANTINE / VALIDATOR CRASH DEMONSTRATIONS PASSED");
