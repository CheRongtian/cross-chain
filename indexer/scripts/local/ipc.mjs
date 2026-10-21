import { safeError } from "./tools.mjs";

const channel = "owned-local-demo";

// Only explicitly IPC-spawned local children have this control plane. Requests
// cannot arrive through a validator's public protocol listener.
export function localRpc(child,runId,{ timeout = 45000 } = {}) {
  let sequence = 0;
  const pending = new Map();
  const close = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Local IPC child disconnected")); }
    pending.clear();
  };
  child.on("message",message => {
    if (message?.channel !== channel || message.runId !== runId || message.pid !== child.pid) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.value);
  });
  child.once("exit",close); child.once("disconnect",close);
  return (operation,argument = {}) => new Promise((resolve,reject) => {
    if (!child.connected) return reject(new Error("Local IPC child is unavailable"));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Local IPC timed out: ${operation}`)); },timeout);
    pending.set(id,{ resolve,reject,timer });
    const failed = error => {
      if (!error || !pending.has(id)) return;
      pending.delete(id); clearTimeout(timer); reject(error);
    };
    try { child.send({ channel,runId,id,operation,argument },failed); } catch (error) { failed(error); }
  });
}

export function serveLocalRpc(handlers,{ runId = process.env.LOCAL_RUN_ID } = {}) {
  if (!process.send || !runId) throw new Error("Local demo control requires an owned IPC parent");
  const receive = async message => {
    if (message?.channel !== channel || message.runId !== runId) return;
    const reply = { channel,runId,id: message.id,pid: process.pid };
    try {
      if (!Object.hasOwn(handlers,message.operation)) throw new Error("Unknown local IPC operation");
      reply.value = await handlers[message.operation](message.argument);
    } catch (error) { reply.error = safeError(error); }
    if (process.connected) process.send(JSON.parse(JSON.stringify(reply,(_,value) => typeof value === "bigint" ? value.toString() : value)),() => {});
  };
  process.on("message",receive);
  return () => process.removeListener("message",receive);
}
