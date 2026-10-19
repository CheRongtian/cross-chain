import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertOwnedPostgres, createOwnedPostgresCluster, disposeOwnedPostgres, postgresStartArguments } from "./helpers/postgres-cluster.mjs";

// Command doubles exercise only helper ownership/lifecycle mechanics. The
// end-to-end scenario separately requires an actual PostgreSQL server outage.
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "owned-postgres-helper-"));
  const registryPath = join(parent, "cluster.json"); const calls = [];
  const state = { running: false, failStart: false, failInit: false, failStop: false };
  const binaries = { initdb: "/fixture/initdb", pg_ctl: "/fixture/pg_ctl", pg_isready: "/fixture/pg_isready" };
  async function run(file, args) {
    calls.push({ file, args: [...args] });
    if (file === binaries.initdb) {
      if (state.failInit) return { code: 1 };
      await writeFile(join(args[args.indexOf("-D") + 1], "PG_VERSION"), "16\n");
    }
    if (file === binaries.pg_ctl) {
      if (args.at(-1) === "status") return { code: state.running ? 0 : 3 };
      if (args.at(-1) === "start") { if (state.failStart) return { code: 1 }; state.running = true; }
      if (args.at(-1) === "stop") { if (state.failStop) return { code: 1 }; state.running = false; }
    }
    return { code: file === binaries.pg_isready && !state.running ? 2 : 0 };
  }
  return { parent, registryPath, calls, state, binaries, run,
    async cleanup() { await disposeOwnedPostgres(registryPath, { run }); await rm(parent, { recursive: true, force: true }); } };
}

test("owned PostgreSQL lifecycle reuses one data directory and initializes only once", async () => {
  const f = await fixture();
  try {
    const cluster = await createOwnedPostgresCluster(f);
    const registry = JSON.parse(await readFile(f.registryPath, "utf8"));
    assert.equal(registry.dataDirectory, cluster.dataDirectory);
    assert.equal(new URL(cluster.databaseUrl).hostname, "127.0.0.1");
    assert.equal(new URL(cluster.databaseUrl).password, "");
    await cluster.stop(); assert.equal(f.state.running, false); await cluster.restart();
    assert.equal(f.state.running, true);
    assert.equal(f.calls.filter(call => call.file === f.binaries.initdb).length, 1);
    const starts = f.calls.filter(call => call.file === f.binaries.pg_ctl && call.args.at(-1) === "start");
    assert.equal(starts.length, 2);
    for (const call of starts) {
      assert.deepEqual(call.args, postgresStartArguments(registry));
      assert.equal(call.args[call.args.indexOf("-D") + 1], cluster.dataDirectory);
      assert.match(call.args[call.args.indexOf("-o") + 1], /^-h 127\.0\.0\.1 /);
      assert.match(call.args[call.args.indexOf("-o") + 1], /fsync=on -c synchronous_commit=on/);
    }
  } finally { await f.cleanup(); }
});

test("ownership mismatch rejects stop and cleanup before invoking any PostgreSQL command", async () => {
  const f = await fixture();
  try {
    const cluster = await createOwnedPostgresCluster(f);
    const markerPath = join(cluster.dataDirectory, "..", "verification-owner.json");
    const original = await readFile(markerPath, "utf8");
    await writeFile(markerPath, JSON.stringify({ ...JSON.parse(original), runId: "00000000-0000-0000-0000-000000000000" }));
    const before = f.calls.length;
    try {
      await assert.rejects(() => cluster.stop(), /ownership marker/);
      await assert.rejects(() => cluster.dispose(), /ownership marker/);
      assert.equal(f.calls.length, before); assert.equal(f.state.running, true);
    } finally { await writeFile(markerPath, original); }
  } finally { await f.cleanup(); }
});

test("restart failure retains owned storage and never falls back to initdb or a new cluster", async () => {
  const f = await fixture();
  try {
    const cluster = await createOwnedPostgresCluster(f);
    await cluster.stop(); f.state.failStart = true;
    await assert.rejects(() => cluster.restart(), /owned PostgreSQL command failed/);
    assert.equal(await readFile(join(cluster.dataDirectory, "PG_VERSION"), "utf8"), "16\n");
    assert.equal(f.calls.filter(call => call.file === f.binaries.initdb).length, 1);
    assert.equal(JSON.parse(await readFile(f.registryPath, "utf8")).dataDirectory, cluster.dataDirectory);
    const record = JSON.parse(await readFile(f.registryPath, "utf8"));
    assert.throws(() => assertOwnedPostgres({ ...record, dataDirectory: f.parent },
      { ...record, dataDirectory: f.parent }), /PGDATA/);
  } finally { await f.cleanup(); }
});

test("failed initial setup retains a cleanup registry and never starts an incomplete cluster", async () => {
  const f = await fixture();
  try {
    f.state.failInit = true;
    await assert.rejects(() => createOwnedPostgresCluster(f), /owned PostgreSQL command failed/);
    const record = JSON.parse(await readFile(f.registryPath, "utf8"));
    assert.ok(record.directory.startsWith(f.parent + "/postgres-restart-"));
    assert.equal(f.calls.filter(call => call.file === f.binaries.pg_ctl).length, 0);
    assert.equal(f.state.running, false);
  } finally { await f.cleanup(); }
});

test("failed server stop prevents directory deletion and can be retried by root cleanup", async () => {
  const f = await fixture();
  try {
    const cluster = await createOwnedPostgresCluster(f);
    f.state.failStop = true;
    await assert.rejects(() => cluster.dispose(), /owned PostgreSQL command failed/);
    assert.equal(f.state.running, true);
    assert.equal(await readFile(join(cluster.dataDirectory, "PG_VERSION"), "utf8"), "16\n");
    assert.equal(JSON.parse(await readFile(f.registryPath, "utf8")).dataDirectory, cluster.dataDirectory);
  } finally { f.state.failStop = false; await f.cleanup(); }
});
