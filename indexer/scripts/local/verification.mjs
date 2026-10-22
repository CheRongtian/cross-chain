import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertLocalOwnership,stopLocalStack } from "./main.mjs";
import { ROOT,processIdentity,readJson,safeError,waitFor } from "./tools.mjs";

export async function verificationStack() {
  if (!process.env.LOCAL_VERIFICATION_OWNER_FILE) throw new Error("Root verification must hand off its existing owned clean stack");
  const record = assertLocalOwnership(await readJson(process.env.LOCAL_VERIFICATION_OWNER_FILE));
  assert.equal(record.parent,join(ROOT,".run/verification"),"fault verification must not reuse a manually running product stack");
  const manifest = await readJson(join(record.directory,"manifest.json"));
  assert.equal(manifest.runId,record.runId); assert.equal(manifest.isolated,true); assert.equal(manifest.ready,true);
  return record;
}

export async function componentDiagnostics(record) {
  try {
    const logs = join(record.directory,"logs");
    for (const name of await readdir(logs)) if (name.endsWith(".log")) {
      console.error(`[fault demonstration component: ${name}]`);
      console.error(safeError({ message: await readFile(join(logs,name),"utf8") }));
    }
  } catch (error) { console.error("Component diagnostics unavailable: " + safeError(error)); }
}

export function assertVerificationStopped(manifest) {
  assert.equal(manifest.ready,false); assert.ok(manifest.stoppedAt,"owned supervisor did not finish cleanup");
  assert.deepEqual(manifest.cleanupErrors,[],"owned resource cleanup failed");
  assert.equal(manifest.failure,undefined,"owned supervisor reported a failure");
}

export async function stopVerificationStack(record) {
  await stopLocalStack(record);
  const owned = [record.supervisor,...await readJson(join(record.directory,"processes.json"))];
  await waitFor("all fault demonstration processes stopped",async () => {
    for (const value of owned) if (await processIdentity(value.pid) === value.identity) return false;
    return true;
  },{ timeout: 10000,retryErrors: false });
  assertVerificationStopped(await readJson(join(record.directory,"manifest.json")));
}
