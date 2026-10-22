import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { demonstrateLocalStack } from "./local/main.mjs";
import { RECOVERY_SCENARIOS } from "./local/recovery-demos.mjs";
import { componentDiagnostics,stopVerificationStack,verificationStack } from "./local/verification.mjs";
import { jsonText,readJson,safeError } from "./local/tools.mjs";

console.log("[relayer, source reorg, replay and composed recovery demonstrations]");
let record;
let current = "owned stack handoff";
try {
  record = await verificationStack();
  const completed = [];
  for (const name of await readdir(record.directory)) if (/^demo-0x[0-9a-f]{64}\.json$/.test(name)) {
    const result = await readJson(join(record.directory,name));
    if (result.destinationTransaction) completed.push(result);
  }
  assert.equal(completed.length,4,"two happy paths and both validator fault messages must precede recovery demonstrations");
  const seen = Object.fromEntries(["messageId","supplier","batchId","destinationTransaction"].map(field => [field,new Set(completed.map(result => result[field]))]));
  for (const scenario of RECOVERY_SCENARIOS) {
    current = scenario;
    const result = await demonstrateLocalStack(record,console.log,scenario);
    assert.equal(result.privacy,"PASSED"); assert.equal(result.messageExecuted,true); assert.equal(result.supplierVerified,true);
    for (const [field,values] of Object.entries(seen)) {
      assert.ok(!values.has(result[field]),`${scenario} must have an independent ${field}`); values.add(result[field]);
    }
    if (scenario === "source-reorg") {
      assert.equal(result.reorg.status,"REORGED");
      assert.ok(!seen.messageId.has(result.reorg.messageId)); assert.ok(!seen.supplier.has(result.reorg.supplier));
      seen.messageId.add(result.reorg.messageId); seen.supplier.add(result.reorg.supplier);
    } else {
      const recovery = result.recovery;
      assert.equal(recovery.scenario,scenario); assert.equal(recovery.originalOwner,"relayer-a");
      assert.equal(recovery.transactionHash,result.destinationTransaction);
      assert.equal(recovery.externalSends,scenario === "replay-attack" ? 2 : 1);
      if (scenario === "replay-attack") {
        assert.equal(result.replay.error,"MessageAlreadyExecuted");
        assert.notEqual(result.replay.transactionHash,result.destinationTransaction);
        assert.equal(recovery.takeoverOwner,null); assert.equal(recovery.takeoverFence,null);
      } else {
        assert.equal(recovery.takeoverOwner,"relayer-b");
        assert.ok(BigInt(recovery.takeoverFence) > BigInt(recovery.originalFence));
      }
      if (scenario === "recovery") {
        assert.equal(result.fault.readyValidators,4); assert.equal(result.fault.committeeSize,4); assert.equal(result.fault.quorum,3);
        assert.equal(result.fault.honestSigners.length,3); assert.ok(!result.fault.honestSigners.includes(result.fault.target));
      }
    }
    console.log(jsonText(result));
  }
} catch (error) {
  console.error(`${current} failed: ${safeError(error)}`); process.exitCode = 1;
  if (record) await componentDiagnostics(record);
} finally {
  if (record) {
    try { await stopVerificationStack(record); }
    catch (error) { console.error("Recovery demonstration cleanup failed: " + safeError(error)); process.exitCode = 1; }
  }
}
if (!process.exitCode) console.log("RELAYER / REORG / REPLAY / RECOVERY DEMONSTRATIONS PASSED");
