import assert from "node:assert/strict";
import { createServer } from "node:http";
import { keccak256 } from "viem";

// Verification-only access paths. Both forward to the same observed Chain B.
// Fault controls are in-process test state, never production configuration.
export async function destinationAccessPath(upstream) {
  const state = { available: true,genesisOverride: null,faults: new Map() };
  const calls = []; const errors = [];
  async function forward(message) {
    const response = await fetch(upstream,{ method: "POST",headers: { "content-type": "application/json" },
      body: JSON.stringify(message),signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`verification upstream returned HTTP ${response.status}`);
    return response.json();
  }
  function reply(response,status,message) {
    response.writeHead(status,{ "content-type": "application/json" }); response.end(JSON.stringify(message));
  }
  const server = createServer(async (request,response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(!Array.isArray(message),"verification access paths use unbatched requests");
      calls.push(message);
      const fault = state.faults.get(message.method);
      const active = fault && (!fault.when || fault.when(message));
      if (active && fault.once) state.faults.delete(message.method);
      if (!state.available || (active && fault.mode === "unavailable")) {
        reply(response,503,{ jsonrpc: "2.0",id: message.id,error: { code: -32603,message: "Injected destination access path unavailable" } }); return;
      }
      if (active && fault.mode === "already-known") {
        assert.equal(message.method,"eth_sendRawTransaction");
        const hash = keccak256(message.params[0]).toLowerCase();
        const proof = await forward({ jsonrpc: "2.0",id: message.id,method: "eth_getTransactionByHash",params: [hash] });
        assert.equal(proof.result?.hash?.toLowerCase(),hash,"already-known injection requires an actual matching Chain B transaction");
        reply(response,200,{ jsonrpc: "2.0",id: message.id,error: { code: -32000,message: "already known" } }); return;
      }
      const result = await forward(message);
      if (active && fault.mode === "drop-after-forward") {
        assert.equal(message.method,"eth_sendRawTransaction");
        assert.equal(result.result?.toLowerCase(),keccak256(message.params[0]).toLowerCase(),"the response may be lost only after actual acceptance");
        response.destroy(); return;
      }
      if (message.method === "eth_getBlockByNumber" && message.params[0] === "0x0" && state.genesisOverride) {
        result.result = { ...result.result,hash: state.genesisOverride };
      }
      reply(response,200,result);
    } catch (error) {
      errors.push(error);
      if (!response.destroyed) reply(response,502,{ jsonrpc: "2.0",id: null,error: { code: -32603,message: "Verification access forwarding failed" } });
    }
  });
  await new Promise((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
  let closing;
  return { state,calls,errors,url: `http://127.0.0.1:${server.address().port}`,
    setFault(method,mode,{ once = true,when } = {}) { state.faults.set(method,{ mode,once,when }); },
    close() {
      if (!closing) {
        closing = new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
      }
      return closing;
    },
  };
}
