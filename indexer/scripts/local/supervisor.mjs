import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access,mkdir } from "node:fs/promises";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createDatabasePool,applyMigrations } from "../../src/db.mjs";
import { applyValidatorMigrations } from "../../../validator/src/db.mjs";
import { createOwnedPostgresCluster,disposeOwnedPostgres } from "../../../scripts/lib/owned-postgres.mjs";
import { createLocalIssuer } from "../../../zk/scripts/local-credential.mjs";
import { validatorKey,LOCAL_DEVELOPMENT_KEY } from "./config.mjs";
import { clients,deployLocalProtocol,snapshotArtifacts } from "./deployment.mjs";
import { observabilityConfiguration } from "./observability.mjs";
import { ROOT,assertPortFree,binary,httpJson,pause,readJson,safeError,spawnLogged,stopRecordedProcess,waitFor,writeJson } from "./tools.mjs";
import { runLocalDemo } from "./demo.mjs";

export async function supervise(config) {
  const registry = join(config.directory,"processes.json");
  const manifestPath = join(config.directory,"manifest.json");
  const pgRegistry = join(config.directory,"postgres.json");
  const children = [];
  const controller = new AbortController();
  const degraded = new Set();
  let stopping = false; let stopped = false; let failure; let busy = false; let pool; let server;
  let phase = "prerequisites"; let ready = false;
  const manifest = { ...config,createdAt: new Date().toISOString(),ready: false };
  const alive = () => { if (failure) throw failure; if (stopping) throw new Error("Local stack is stopping"); };
  async function cleanup() {
    if (stopped) return;
    stopping = true; stopped = true; ready = false;
    controller.abort();
    for (const { record } of [...children].reverse()) {
      try { await stopRecordedProcess(record); } catch (error) { console.error(`Cleanup ${record.name}: ${safeError(error)}`); process.exitCode = 1; }
    }
    await pool?.end();
    try { await disposeOwnedPostgres(pgRegistry); } catch (error) { console.error(`Owned database cleanup: ${safeError(error)}`); process.exitCode = 1; }
    await writeJson(manifestPath,{ ...manifest,ready: false,stoppedAt: new Date().toISOString(),failure: failure ? safeError(failure) : undefined });
    if (server?.listening) { server.closeAllConnections(); await new Promise(accept => server.close(accept)); }
  }
  process.once("SIGTERM",() => { stopping = true; }); process.once("SIGINT",() => { stopping = true; });
  async function spawn(name,file,args,env = {}) {
    alive();
    const child = await spawnLogged(name,file,args,{ directory: config.directory,env: { ...process.env,...env },
      onExit: (name,code,signal) => {
        if (stopping) return;
        if (phase === "ready" && ["prometheus","grafana","api"].includes(name)) {
          degraded.add(name); ready = false;
          manifest.ready = false; manifest.degraded = [...degraded];
          writeJson(manifestPath,manifest).catch(error => console.error("Observation status persistence failed: " + safeError(error)));
          console.error(`Observation surface ${name} stopped; core protocol workers remain running. Use stop.sh/start.sh to restore the complete stack.`);
        } else failure = new Error(`${name} exited (${signal ?? code}); see ${join(config.directory,"logs",name + ".log")}`);
      } });
    children.push(child); await writeJson(registry,children.map(value => value.record)); return child;
  }
  const node = (name,path,args,env) => spawn(name,process.execPath,[join(ROOT,path),...args],env);
  const wait = (label,fn,timeout) => waitFor(label,fn,{ alive,timeout });
  try {
    await mkdir(config.directory,{ recursive: true,mode: 0o700 });
    await mkdir(join(config.directory,"private"),{ mode: 0o700 });
    for (const port of [config.ports.chainA,config.ports.chainB,config.ports.api,config.ports.prometheus,config.ports.grafana,
      ...config.ports.validators,...config.ports.metrics,config.ports.control]) await assertPortFree(port);
    const anvil = await binary("anvil",process.env.ANVIL_BIN);
    const observation = await observabilityConfiguration(config);
    const artifacts = await snapshotArtifacts(config.directory);
    const issuer = await createLocalIssuer();
    // The parent shell receives progress through this run's public status.
    server = createServer(async (request,response) => {
      const send = (status,value) => { response.writeHead(status,{ "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (request.method === "GET" && request.url === "/status") return send(200,{ runId: config.runId,ready,phase,degraded: [...degraded],failure: failure ? safeError(failure) : null });
      if (request.headers["x-local-run"] !== config.runId) return send(403,{ error: "Run ownership mismatch" });
      if (request.method === "POST" && request.url === "/stop") { send(200,{ stopping: true }); stopping = true; return; }
      if (request.method !== "POST" || request.url !== "/demo") return send(404,{ error: "Unknown local control operation" });
      if (!ready || busy) return send(409,{ error: busy ? "A demonstration is already running" : "Stack is not ready" });
      busy = true;
      response.writeHead(200,{ "content-type": "application/x-ndjson" });
      const progress = message => { if (!response.destroyed) response.write(JSON.stringify({ progress: message }) + "\n"); };
      try {
        const result = await runLocalDemo({ config: manifest,pool,issuer,artifacts,alive,progress,signal: controller.signal });
        if (!response.destroyed) response.write(JSON.stringify({ result }) + "\n");
      } catch (error) { if (!response.destroyed) response.write(JSON.stringify({ error: safeError(error) }) + "\n"); }
      finally { busy = false; response.end(); }
    });
    await new Promise((accept,reject) => { server.once("error",reject); server.listen(config.ports.control,"127.0.0.1",accept); });
    phase = "database";
    // Existing operator credentials stay in process memory/environment only.
    const databaseUrl = !config.isolated && process.env.DATABASE_URL ? process.env.DATABASE_URL :
      (await createOwnedPostgresCluster({ parent: config.directory,registryPath: pgRegistry })).databaseUrl;
    pool = createDatabasePool({ databaseUrl });
    pool.options.connectionTimeoutMillis = 10000; pool.options.query_timeout = 30000;
    pool.on("error",error => { failure = new Error("Local database connection failed: " + safeError(error)); });
    await pool.query("SELECT 1");
    await applyMigrations(pool,config.schema);
    const peers = config.ports.validators.map((port,index) => ({ address: privateKeyToAccount(validatorKey(index)).address.toLowerCase(),url: `http://127.0.0.1:${port}` }));
    const history = [{ validatorEpoch: "7",activationBatchEpoch: "0",validators: peers.map(peer => peer.address) }];
    manifest.peers = peers; manifest.history = history;
    manifest.validatorSchemas = peers.map((_,index) => config.schema + "_v" + (index + 1));
    for (const schema of manifest.validatorSchemas) await applyValidatorMigrations(pool,schema);
    // Fresh namespaces must contain migrations only. No fixture/truth import.
    for (const name of ["source_messages","message_batches","batch_quorum_certificates","delivery_jobs","transaction_attempts"]) {
      assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM "${config.schema}"."${name}"`)).rows[0].count,0,`fresh ${name} must be empty`);
    }
    phase = "chains";
    await spawn("chain-a",anvil,["--host","127.0.0.1","--port",String(config.ports.chainA),"--chain-id","10011","--silent"]);
    await spawn("chain-b",anvil,["--host","127.0.0.1","--port",String(config.ports.chainB),"--chain-id","2001","--silent"]);
    const a = clients(config.chainA,10011).publicClient; const b = clients(config.chainB,2001).publicClient;
    await wait("owned Chain A",async () => await a.getChainId() === 10011);
    await wait("owned Chain B",async () => await b.getChainId() === 2001);
    phase = "deployment";
    manifest.deployments = await deployLocalProtocol(config,issuer,peers.map(value => value.address),artifacts);
    manifest.genesisHash = (await b.getBlock({ blockNumber: 0n })).hash;
    const environment = { DATABASE_URL: databaseUrl,INDEXER_DB_SCHEMA: config.schema,
      CHAIN_A_DOMAIN: "10011",CHAIN_A_RPC_URL: config.chainA,SOURCE_GATEWAY_ADDRESS: manifest.deployments.sourceGateway,SOURCE_GATEWAY_START_BLOCK: "0",
      INDEXER_BLOCK_RANGE: "2000",INDEXER_POLL_INTERVAL_MS: "200",FINALITY_POLL_INTERVAL_MS: "200",FINALITY_BLOCK_DEPTH: "2",
      VALIDATOR_SET_HISTORY: JSON.stringify(history),VALIDATOR_SET_HISTORY_FILE: "",VALIDATOR_PEERS: JSON.stringify(peers),
      CHAIN_B_RPC_URL: config.chainB,CHAIN_B_RPC_URLS: JSON.stringify([config.chainB]),CHAIN_B_CHAIN_ID: "2001",CHAIN_B_GENESIS_HASH: manifest.genesisHash,
      RELAYER_A_PRIVATE_KEY: LOCAL_DEVELOPMENT_KEY,RELAYER_LEASE_MS: "30000",RELAYER_MAX_JOBS_PER_RUN: "10",DESTINATION_CONFIRMATIONS: "3",
      METRICS_HOST: "127.0.0.1",IDENTITY_APPLICATION_ADDRESS: manifest.deployments.identityApplication,
      PRODUCTION_DESTINATION_GATEWAY_ADDRESS: manifest.deployments.destinationGateway,
      MESSAGE_QUERY_API_HOST: "127.0.0.1",MESSAGE_QUERY_API_PORT: String(config.ports.api),
      MESSAGE_QUERY_VALIDATOR_STORES: JSON.stringify(peers.map((peer,index) => ({ validatorAddress: peer.address,databaseSchema: manifest.validatorSchemas[index] }))),
    };
    phase = "validators";
    for (const [index,peer] of peers.entries()) {
      await node("validator-" + (index + 1),"validator/src/main.mjs",[],{ ...environment,
        SOURCE_DATABASE_URL: databaseUrl,SOURCE_DB_SCHEMA: config.schema,VALIDATOR_DATABASE_URL: databaseUrl,VALIDATOR_DB_SCHEMA: manifest.validatorSchemas[index],
        VALIDATOR_PRIVATE_KEY: validatorKey(index),VALIDATOR_LISTEN_HOST: "127.0.0.1",VALIDATOR_LISTEN_PORT: String(config.ports.validators[index]),
        PBFT_VIEW_TIMEOUT_MS: "30000",METRICS_PORT: "" });
      await wait("validator " + peer.address,async () => (await httpJson(peer.url + "/health")).ready);
    }
    phase = "workers";
    await node("indexer","indexer/src/main.mjs",[],{ ...environment,METRICS_PORT: String(config.ports.metrics[0]) });
    await node("finality","indexer/src/main.mjs",["finality"],{ ...environment,METRICS_PORT: String(config.ports.metrics[1]) });
    for (const [index,role] of ["pipeline","relayer-a","relayer-b"].entries()) {
      const readyFile = join(config.directory,role + "-ready.json");
      await node(role,"indexer/scripts/local/worker.mjs",[role],{ ...environment,RELAYER_WORKER_ID: role,LOCAL_READY_FILE: readyFile,METRICS_PORT: String(config.ports.metrics[index + 2]) });
      await wait(role,async () => { await access(readyFile); return (await readJson(readyFile)).ready; });
    }
    await node("api","indexer/src/api/main.mjs",[],{ ...environment,METRICS_PORT: "" });
    await wait("Explorer/API",async () => { await httpJson(config.api + "/api/v1/messages"); return true; });
    for (const port of config.ports.metrics) await wait("metrics " + port,async () => (await fetch(`http://127.0.0.1:${port}/metrics`,{ signal: AbortSignal.timeout(3000) })).ok);
    phase = "observability";
    await spawn("prometheus",observation.prometheus,["--config.file=" + join(observation.directory,"prometheus.yml"),
      "--storage.tsdb.path=" + join(observation.directory,"prometheus-data"),"--web.listen-address=127.0.0.1:" + config.ports.prometheus]);
    await spawn("grafana",observation.grafana,["server","--homepath=" + observation.home,"--config=" + observation.grafanaConfig],{
      ...Object.fromEntries(Object.keys(process.env).filter(name => name.startsWith("GF_")).map(name => [name,undefined])),
      GF_PATHS_PROVISIONING: observation.provisioning,GF_SERVER_HTTP_ADDR: "127.0.0.1",GF_SERVER_HTTP_PORT: String(config.ports.grafana),
      GF_AUTH_ANONYMOUS_ENABLED: "true",GF_AUTH_ANONYMOUS_ORG_ROLE: "Viewer",GF_SECURITY_ADMIN_PASSWORD: randomUUID(),
    });
    await wait("Prometheus readiness",async () => (await fetch(config.prometheus + "/-/ready",{ signal: AbortSignal.timeout(3000) })).ok);
    await wait("Grafana health",async () => (await httpJson(config.grafana + "/api/health")).database === "ok");
    await wait("provisioned Grafana dashboard",async () => (await httpJson(config.grafana + "/api/dashboards/uid/cross-chain-protocol")).dashboard.uid === "cross-chain-protocol");
    const datasource = await httpJson(config.grafana + "/api/datasources/uid/cross-chain-prometheus");
    assert.equal(datasource.url,config.prometheus);
    await wait("all ten production scrape targets",async () => {
      const targets = (await httpJson(config.prometheus + "/api/v1/targets")).data.activeTargets;
      return targets.length === 10 && targets.every(target => target.health === "up");
    });
    phase = "ready"; ready = true; manifest.ready = true;
    manifest.components = children.map(({ record }) => ({ name: record.name,pid: record.pid,log: record.log }));
    await writeJson(manifestPath,manifest);
    console.log("Local stack ready; owned runtime: " + config.directory);
    while (!stopping) { alive(); await pause(250); }
  } catch (error) { failure = error; console.error(`Local stack failed during ${phase}: ${safeError(error)}`); process.exitCode = 1; }
  finally { await cleanup(); }
}
