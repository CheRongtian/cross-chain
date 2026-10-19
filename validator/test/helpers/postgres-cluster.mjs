import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const OWNER_FILE = "verification-owner.json";

async function executable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* try the next PATH entry */ }
  }
  throw new Error(`PostgreSQL restart verification requires an existing ${name} executable`);
}

export async function postgresBinaries() {
  // Resolve all tools from the same installed server distribution.
  let directory;
  try { directory = dirname(await executable("initdb")); }
  catch {
    const pgConfig = await executable("pg_config");
    directory = (await execute(pgConfig, ["--bindir"], { timeout: 5000 })).stdout.trim();
  }
  const binaries = {};
  for (const name of ["initdb", "pg_ctl", "pg_isready"]) {
    const path = join(directory, name);
    try { await access(path, constants.X_OK); }
    catch { throw new Error(`PostgreSQL restart verification requires ${name} in the existing server installation: ${directory}`); }
    binaries[name] = path;
  }
  return binaries;
}

export function assertOwnedPostgres(record, marker) {
  assert.equal(record.runId, marker.runId, "PostgreSQL ownership marker differs from this verification run");
  assert.match(record.runId, /^[0-9a-f-]{36}$/);
  assert.equal(resolve(record.directory), join(resolve(record.parent), `postgres-restart-${record.name}`));
  assert.match(record.name, /^[A-Za-z0-9]+$/);
  assert.equal(resolve(record.dataDirectory), join(resolve(record.directory), "data"), "PostgreSQL PGDATA must be inside its verification-owned directory");
  assert.equal(marker.dataDirectory, record.dataDirectory);
  assert.equal(marker.port, record.port);
  assert.ok(Number.isInteger(record.port) && record.port > 0 && record.port < 65536);
  return record;
}

export function postgresStartArguments(record) {
  return ["-D", record.dataDirectory, "-l", join(record.directory, "server.log"),
    "-o", `-h 127.0.0.1 -p ${record.port} -c unix_socket_directories='' -c fsync=on -c synchronous_commit=on`,
    "-w", "-t", "20", "start"];
}

async function runCommand(file, args) {
  try {
    const result = await execute(file, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { code: 0 };
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    if (typeof error.code === "number") return { code: error.code };
    throw error;
  }
}

async function ownedRecord(registryPath) {
  const record = JSON.parse(await readFile(registryPath, "utf8"));
  const marker = JSON.parse(await readFile(join(record.directory, OWNER_FILE), "utf8"));
  return assertOwnedPostgres(record, marker);
}

async function successful(run, file, args) {
  const result = await run(file, args);
  assert.equal(result.code, 0, `owned PostgreSQL command failed: ${file.split("/").at(-1)} ${args.at(-1)}`);
}

export async function disposeOwnedPostgres(registryPath, { run = runCommand } = {}) {
  try { await access(registryPath); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const record = await ownedRecord(registryPath);
  let initialized = true;
  try { await access(join(record.dataDirectory, "PG_VERSION")); }
  catch (error) { if (error.code !== "ENOENT") throw error; initialized = false; }
  const status = initialized ? await run(record.binaries.pg_ctl, ["-D", record.dataDirectory, "status"]) : { code: 3 };
  if (status.code === 0) {
    await successful(run, record.binaries.pg_ctl, ["-D", record.dataDirectory, "-m", "immediate", "-w", "-t", "20", "stop"]);
  } else {
    assert.equal(status.code, 3, "cannot establish whether the owned PostgreSQL server is stopped; retaining its files");
  }
  // Deletion happens only after the owned server is stopped, during cleanup.
  await rm(record.directory, { recursive: true, force: true });
  await rm(registryPath, { force: true });
}

export async function createOwnedPostgresCluster({ parent, registryPath, binaries, run = runCommand } = {}) {
  assert.ok(parent && registryPath, "verification must supply its temporary parent and PostgreSQL cleanup registry");
  const tools = binaries ?? await postgresBinaries();
  const directory = await mkdtemp(join(resolve(parent), "postgres-restart-"));
  const reservation = createServer();
  let record;
  try {
    await new Promise((accept, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", accept); });
    record = { parent: resolve(parent), directory, name: directory.slice(join(resolve(parent), "postgres-restart-").length),
      runId: randomUUID(), dataDirectory: join(directory, "data"), port: reservation.address().port, binaries: tools };
    await writeFile(join(directory, OWNER_FILE), JSON.stringify({ runId: record.runId, dataDirectory: record.dataDirectory, port: record.port }));
    await writeFile(registryPath, JSON.stringify(record), { flag: "wx" });
    await mkdir(record.dataDirectory);
    await successful(run, tools.initdb, ["-D", record.dataDirectory, "-U", "verification_owner", "--auth-local=reject", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
  } finally {
    if (reservation.listening) await new Promise((accept, reject) => reservation.close(error => error ? reject(error) : accept()));
  }
  const databaseUrl = `postgresql://verification_owner@127.0.0.1:${record.port}/postgres`;
  async function start() {
    const owned = await ownedRecord(registryPath);
    await access(join(owned.dataDirectory, "PG_VERSION"));
    try {
      await successful(run, tools.pg_ctl, postgresStartArguments(owned));
      await successful(run, tools.pg_isready, ["-h", "127.0.0.1", "-p", String(owned.port), "-U", "verification_owner", "-d", "postgres", "-t", "3"]);
    } catch (error) {
      try { process.stderr.write(await readFile(join(directory, "server.log"), "utf8")); } catch { /* preserve the startup failure */ }
      throw error;
    }
  }
  async function assertDown() {
    await ownedRecord(registryPath);
    const status = await run(tools.pg_ctl, ["-D", record.dataDirectory, "status"]);
    assert.equal(status.code, 3, "owned PostgreSQL server must actually be stopped");
    const readiness = await run(tools.pg_isready, ["-h", "127.0.0.1", "-p", String(record.port), "-U", "verification_owner", "-d", "postgres", "-t", "3"]);
    assert.equal(readiness.code, 2, "owned PostgreSQL port must report no response");
  }
  await start();
  return {
    databaseUrl, dataDirectory: record.dataDirectory, runId: record.runId, port: record.port,
    async stop() {
      await ownedRecord(registryPath);
      await successful(run, tools.pg_ctl, ["-D", record.dataDirectory, "-m", "immediate", "-w", "-t", "20", "stop"]);
      await assertDown();
    },
    assertDown,
    async restart() { await assertDown(); await start(); },
    dispose: () => disposeOwnedPostgres(registryPath, { run }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , command, registryPath] = process.argv;
  if (command === "--check-tools") {
    const tools = await postgresBinaries();
    for (const [name, path] of Object.entries(tools)) console.log(`Verified existing PostgreSQL tool ${name}: ${path}`);
  } else {
    if (command !== "--dispose" || !registryPath) throw new Error("usage: postgres-cluster.mjs --check-tools | --dispose <owned-registry-file>");
    await disposeOwnedPostgres(registryPath);
  }
}
