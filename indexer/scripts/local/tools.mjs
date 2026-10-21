import { spawn,execFile } from "node:child_process";
import { constants } from "node:fs";
import { access,readFile,writeFile,mkdir,open } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Anchor artifact and subprocess paths to the repository root.
export const ROOT = fileURLToPath(new URL("../../../",import.meta.url));
export const execute = promisify(execFile);
export const jsonText = value => JSON.stringify(value,(_,item) => typeof item === "bigint" ? item.toString() : item,2);
export const readJson = async path => JSON.parse(await readFile(path,"utf8"));
export const writeJson = (path,value) => writeFile(path,jsonText(value) + "\n",{ mode: 0o600 });
export const pause = milliseconds => new Promise(accept => setTimeout(accept,milliseconds));
export function safeError(error) {
  let text = error.shortMessage ?? error.message ?? String(error);
  for (const [name,value] of Object.entries(process.env)) {
    if (value && /PASSWORD|PRIVATE_KEY|DATABASE_URL/.test(name)) text = text.replaceAll(value,"<redacted>");
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s]+/g,"<database>");
}
export async function binary(name,configured) {
  const candidates = configured ? [resolve(configured)] : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path,name));
  for (const path of candidates) {
    try { await access(path,constants.X_OK); return path; } catch { /* next installed executable */ }
  }
  throw new Error(`Missing existing ${name} executable; configure its path in .env. No installation is performed.`);
}
export async function freePort() {
  const server = createServer();
  await new Promise((accept,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",accept); });
  const port = server.address().port;
  await new Promise((accept,reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}
export async function freePorts(count) {
  const reservations = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = createServer(); reservations.push(server);
      await new Promise((accept,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",accept); });
    }
    return reservations.map(server => server.address().port);
  } finally {
    await Promise.all(reservations.filter(server => server.listening).map(server => new Promise((accept,reject) => server.close(error => error ? reject(error) : accept()))));
  }
}
export async function assertPortFree(port) {
  const server = createServer();
  try { await new Promise((accept,reject) => { server.once("error",reject); server.listen(port,"127.0.0.1",accept); }); }
  catch { throw new Error(`Local port ${port} is occupied; stop the owning service or change the local port in .env`); }
  await new Promise((accept,reject) => server.close(error => error ? reject(error) : accept()));
}
export async function httpJson(url,body) {
  const response = await fetch(url,{ method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : jsonText(body),signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${new URL(url).pathname}: ${result.reason ?? result.error ?? response.status}`);
  return result;
}
export async function waitFor(label,operation,{ timeout = 60000,interval = 250,alive = () => {},retryErrors = true } = {}) {
  const deadline = Date.now() + timeout;
  let last = "not ready";
  while (Date.now() < deadline) {
    alive();
    try { const result = await operation(); if (result) return result; last = "not ready"; }
    catch (error) { if (!retryErrors || error.fatal) throw error; last = safeError(error); }
    await pause(interval);
  }
  throw new Error(`Timed out waiting for ${label}; last observation: ${last}`);
}

// A PID alone is insufficient after a stale run. The OS start time and command
// are recorded before readiness and checked before any fallback signal.
export async function processIdentity(pid) {
  try {
    const { stdout } = await execute("ps",["-p",String(pid),"-o","lstart=","-o","command="],{ timeout: 5000 });
    return stdout.trim() || null;
  } catch (error) { if (error.code === 1) return null; throw error; }
}
export async function stopRecordedProcess(record,{ graceMs = 10000 } = {}) {
  if (!record?.identity || await processIdentity(record.pid) !== record.identity) return;
  process.kill(record.pid,"SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && await processIdentity(record.pid) === record.identity) await pause(100);
  if (await processIdentity(record.pid) === record.identity) process.kill(record.pid,"SIGKILL");
}
export async function spawnLogged(name,file,args,{ directory,env,onExit }) {
  await mkdir(join(directory,"logs"),{ recursive: true,mode: 0o700 });
  const log = join(directory,"logs",name + ".log");
  const output = await open(log,"a",0o600);
  const child = spawn(file,args,{ cwd: ROOT,env,stdio: ["ignore",output.fd,output.fd] });
  // Register before the first await: spawn/error may fire on the next tick,
  // before an asynchronous file close or ps operation completes.
  const spawned = new Promise((accept,reject) => { child.once("spawn",accept); child.once("error",reject); });
  child.once("exit",(code,signal) => onExit?.(name,code,signal));
  try {
    await spawned;
    const record = { name,pid: child.pid,identity: await processIdentity(child.pid),log };
    if (child.exitCode !== null || child.signalCode !== null || !record.identity) throw new Error(`${name} exited during startup; see ${log}`);
    return { child,record };
  } catch (error) { if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); throw error; }
  finally { await output.close(); }
}
