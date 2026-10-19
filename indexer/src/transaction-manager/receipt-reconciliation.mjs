import { normalizeBytes32 } from "../canonical-message.mjs";
import { observeIntentReceipts } from "./receipts.mjs";
import { TransactionError } from "./config.mjs";
import { safeRelayerMessage } from "../relayer/config.mjs";

const terminal = status => status === "CONFIRMED" || status === "REVERTED";

// Extends the existing receipt pass; the caller supplies its bounded selection
// and fixed view. No parallel scheduler, retry policy or nonce allocator.
export async function revalidateTerminalReceipts({ ids,store,rpc,config,view,resolveMessageId,hooks = {} }) {
  const results = [];
  for (const id of ids) {
    try {
      results.push(await store.withRecoveryLock(id,async context => {
        const snapshot = await store.getRecoverySnapshot(id);
        if (!snapshot || !terminal(snapshot.intent.status)) return { deliveryJobId: id,action: "UNCHANGED" };
        const winner = snapshot.winningAttempt;
        const height = BigInt(winner.receiptBlockNumber);
        if (height > view.head) return { deliveryJobId: id,action: "UNRESOLVED",reason: "RPC_VIEW_INCOMPLETE" };
        const block = await rpc.canonicalBlock(height,view);
        const replacementBlockHash = normalizeBytes32(block.hash);
        const observation = await observeIntentReceipts({ stored: snapshot,rpc,config,view,forceAll: true,hooks });
        context.assertHeld();
        await rpc.assertView(view);
        if (replacementBlockHash === winner.receiptBlockHash) {
          if (!observation.winner) return { deliveryJobId: id,action: "UNRESOLVED",reason: "RECEIPT_EVIDENCE_UNAVAILABLE" };
          const current = observation.winner;
          if (current.attempt.attemptId !== winner.attemptId || current.blockNumber !== height ||
              current.blockHash !== winner.receiptBlockHash || current.status !== winner.receiptStatus) throw new TransactionError("INCONSISTENT_RPC_VIEW");
          return { deliveryJobId: id,action: observation.finalizable ? "CANONICAL" : "UNRESOLVED" };
        }
        // Positive same-height replacement, never receipt=null, authorizes
        // invalidating the current cache. All candidates were inspected first.
        const current = observation.winner;
        await rpc.assertView(view); context.assertHeld();
        const receipt = current && observation.finalizable ? { transactionHash: current.attempt.transactionHash,
          blockNumber: current.blockNumber,blockHash: current.blockHash,status: current.status,head: view.head } : undefined;
        const stored = await store.reconcileDestinationReorg(snapshot,{ replacementBlockHash,view,receipt });
        // Once orphaning is proven, preserve it even if the subsequent replay
        // read is unavailable. The durable PENDING state makes no stale final
        // claim; the send guard must independently recheck replay before send.
        const replay = !current ? await rpc.gatewayReplay(snapshot.intent.destinationGateway,
          await resolveMessageId(id),view) : null;
        if (replay && stored.intent.retryStoppedAt === null) await store.stopRetry(id,"GATEWAY_ALREADY_EXECUTED");
        await hooks.afterDestinationReorg?.({ id,stored,replacementBlockHash,view,candidatesChecked: snapshot.attempts.length,replay });
        return { deliveryJobId: id,action: receipt ? "REINCLUDED" : replay ? "GATEWAY_ALREADY_EXECUTED" : current ? "AWAITING_CONFIRMATIONS" : "REORG_RECOVERY",
          historicalTransactionHash: winner.transactionHash,formerBlockHash: winner.receiptBlockHash,replacementBlockHash,
          candidatesChecked: snapshot.attempts.length,transactionHash: current?.attempt.transactionHash };
      }));
    } catch (error) {
      if (!["TRANSACTION_RECOVERY_BUSY","RECOVERY_STATE_CHANGED","RPC_UNAVAILABLE","INCONSISTENT_RPC_VIEW","RPC_VIEW_INCOMPLETE",
        "NONCANONICAL_TRANSACTION_RECEIPT","CONFLICTING_CANONICAL_NONCE_WINNERS"].includes(error.code)) throw error;
      results.push({ deliveryJobId: id,action: "UNRESOLVED",reason: error.code,errorMessage: safeRelayerMessage(error,config) });
    }
  }
  return Object.freeze({ checked: ids.length,results: Object.freeze(results) });
}
