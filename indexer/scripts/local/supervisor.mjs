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
import { ROOT,assertPortFree,binary,httpJson,pause,processIdentity,readJson,safeError,spawnLogged,stopRecordedProcess,waitFor,writeJson } from "./tools.mjs";
import { runLocalDemo } from "./demo.mjs";
import { localRpc } from "./ipc.mjs";
import { assertOwnedValidator,runFaultDemo } from "./pbft-faults.mjs";

export async function supervise(config) {
  const registry = join(config.directory,"processes.json");
  const manifestPath = join(config.directory,"manifest.json");
  const pgRegistry = join(config.directory,"postgres.json");
  const children = [];
  const controller = new AbortController();
  const degraded = new Set();
  const expectedCrashes = new Set();
  const validatorChildren = [];
  const validatorEnvironments = [];
  let pipeline;
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
  const requestStop = () => { stopping = true; controller.abort(); };
  process.once("SIGTERM",requestStop); process.once("SIGINT",requestStop);
  async function spawn(name,file,args,env = {},ipc = false) {
    alive();
    const child = await spawnLogged(name,file,args,{ directory: config.directory,env: { ...process.env,...env,LOCAL_RUN_ID: config.runId },ipc,
      onExit: (name,code,signal,pid) => {
        if (stopping) return;
        if (signal === "SIGKILL" && expectedCrashes.delete(pid)) return;
        if (phase === "ready" && ["prometheus","grafana","api"].includes(name)) {
          degraded.add(name); ready = false;
          manifest.ready = false; manifest.degraded = [...degraded];
          writeJson(manifestPath,manifest).catch(error => console.error("Observation status persistence failed: " + safeError(error)));
          console.error(`Observation surface ${name} stopped; core protocol workers remain running. Use stop.sh/start.sh to restore the complete stack.`);
        } else failure = new Error(`${name} exited (${signal ?? code}); see ${join(config.directory,"logs",name + ".log")}`);
      } });
    if (ipc) child.rpc = localRpc(child.child,config.runId);
    children.push(child); await writeJson(registry,children.map(value => value.record)); return child;
  }
  const node = (name,path,args,env,ipc = false) => spawn(name,process.execPath,[join(ROOT,path),...args],env,ipc);
  const wait = (label,fn,timeout) => waitFor(label,fn,{ alive,timeout });
  async function publishComponents() {
    manifest.components = [...new Map(children.map(({ record }) => [record.name,{ name: record.name,pid: record.pid,log: record.log }])).values()];
    await writeJson(manifestPath,manifest);
  }
  async function startValidator(index) {
    const owned = await node("validator-" + (index + 1),"validator/scripts/local-validator.mjs",[],validatorEnvironments[index],true);
    validatorChildren[index] = owned;
    const peer = manifest.peers[index];
    await wait("validator " + peer.address,async () => {
      const health = await httpJson(peer.url + "/health");
      return health.ready && health.pid === owned.record.pid && health.validatorAddress === peer.address;
    });
    const identity = await owned.rpc("status");
    assert.equal(identity.pid,owned.record.pid); assert.equal(identity.address,peer.address);
    assert.equal(identity.schema,manifest.validatorSchemas[index]);
    await publishComponents();
    return owned;
  }
  const faultProcesses = {
    at: index => validatorChildren[index],
    fail(error) { ready = false; manifest.ready = false; failure = new Error("Fault control restoration failed: " + safeError(error)); },
    async crash(index) {
      const owned = validatorChildren[index];
      assert.ok(children.includes(owned));
      assert.equal(owned.child.exitCode,null); assert.equal(owned.child.signalCode,null);
      const observedIdentity = await processIdentity(owned.record.pid);
      const recorded = (await readJson(registry)).find(record => record.pid === owned.record.pid);
      const health = await httpJson(manifest.peers[index].url + "/health");
      const published = (await readJson(manifestPath)).components.find(value => value.name === owned.record.name);
      assertOwnedValidator({ record: owned.record,observedIdentity,registered: recorded,published,health,address: manifest.peers[index].address });
      ready = false; manifest.ready = false; await publishComponents();
      expectedCrashes.add(owned.record.pid);
      owned.child.kill("SIGKILL");
      await wait("designated validator abrupt exit",async () => owned.child.signalCode === "SIGKILL",10000);
      assert.equal(await processIdentity(owned.record.pid),null);
      return owned.record.pid;
    },
    async restore(index) {
      const old = validatorChildren[index];
      if (old.child.exitCode !== null || old.child.signalCode !== null) await startValidator(index);
      for (const [position,peer] of manifest.peers.entries()) {
        const health = await httpJson(peer.url + "/health");
        assert.equal(health.ready,true); assert.equal(health.validatorAddress,peer.address);
        assert.equal(health.pid,validatorChildren[position].record.pid);
      }
      await wait("all observation targets after validator recovery",async () => {
        const targets = (await httpJson(config.prometheus + "/api/v1/targets")).data.activeTargets;
        return targets.length === 10 && targets.every(target => target.health === "up");
      });
      ready = degraded.size === 0; manifest.ready = ready; await publishComponents();
      assert.equal(ready,true); return validatorChildren[index].record.pid;
    },
  };
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
      if (request.method === "POST" && request.url === "/stop") { send(200,{ stopping: true }); requestStop(); return; }
      const scenario = ({ "/demo": "happy-path","/demo/byzantine-validator": "byzantine-validator","/demo/validator-crash": "validator-crash" })[request.url];
      if (request.method !== "POST" || !scenario) return send(404,{ error: "Unknown local control operation" });
      if (scenario !== "happy-path" && !config.isolated) return send(404,{ error: "Validator faults are restricted to full verification" });
      if (!ready || busy) return send(409,{ error: busy ? "A demonstration is already running" : "Stack is not ready" });
      busy = true;
      response.writeHead(200,{ "content-type": "application/x-ndjson" });
      const progress = message => { if (!response.destroyed) response.write(JSON.stringify({ progress: message }) + "\n"); };
      try {
        const options = { config: manifest,pool,issuer,artifacts,alive,progress,signal: controller.signal };
        const result = scenario === "happy-path" ? await runLocalDemo(options) :
          await runFaultDemo({ ...options,scenario,pipeline: pipeline.rpc,processes: faultProcesses });
        await writeJson(join(config.directory,"demo-result.json"),result);
        await writeJson(join(config.directory,`demo-${result.messageId}.json`),result);
        if (!response.destroyed) response.write(JSON.stringify({ result }) + "\n");
      } catch (error) {
        if (!ready) failure = new Error("Fault demonstration could not restore complete readiness: " + safeError(error));
        if (!response.destroyed) response.write(JSON.stringify({ error: safeError(error) }) + "\n");
      }
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
    for (const index of peers.keys()) {
      validatorEnvironments[index] = { ...environment,
        SOURCE_DATABASE_URL: databaseUrl,SOURCE_DB_SCHEMA: config.schema,VALIDATOR_DATABASE_URL: databaseUrl,VALIDATOR_DB_SCHEMA: manifest.validatorSchemas[index],
        VALIDATOR_PRIVATE_KEY: validatorKey(index),VALIDATOR_LISTEN_HOST: "127.0.0.1",VALIDATOR_LISTEN_PORT: String(config.ports.validators[index]),
        PBFT_VIEW_TIMEOUT_MS: "30000",METRICS_PORT: "" };
      await startValidator(index);
    }
    phase = "workers";
    await node("indexer","indexer/src/main.mjs",[],{ ...environment,METRICS_PORT: String(config.ports.metrics[0]) });
    await node("finality","indexer/src/main.mjs",["finality"],{ ...environment,METRICS_PORT: String(config.ports.metrics[1]) });
    for (const [index,role] of ["pipeline","relayer-a","relayer-b"].entries()) {
      const readyFile = join(config.directory,role + "-ready.json");
      const owned = await node(role,"indexer/scripts/local/worker.mjs",[role],{ ...environment,RELAYER_WORKER_ID: role,LOCAL_READY_FILE: readyFile,METRICS_PORT: String(config.ports.metrics[index + 2]) },role === "pipeline");
      if (role === "pipeline") pipeline = owned;
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
    await publishComponents();
    console.log("Local stack ready; owned runtime: " + config.directory);
    while (!stopping) { alive(); await pause(250); }
  } catch (error) { failure = error; console.error(`Local stack failed during ${phase}: ${safeError(error)}`); process.exitCode = 1; }
  finally { await cleanup(); }
}
