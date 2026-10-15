import { normalizeAddress } from "../canonical-message.mjs";
import { encodeGatewaySubmission } from "./encoding.mjs";
import { RelayerError, safeRelayerMessage } from "./config.mjs";
import { createRelayerLeaseRepository } from "./leases.mjs";

export function createRelayerWorker({ config,pool,queue,transactionManager,
  leases = createRelayerLeaseRepository({ config,pool,queue }),
  afterLeaseAcquired = async () => {},afterPrepared = async () => {} }) {
  const verification = { validatorSets: config.validatorSets,sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway };
  async function protectedOperation(operation) {
    try { return await operation(); }
    catch (error) {
      const safe = new Error(safeRelayerMessage(error,config));
      safe.code = error?.code ?? "RELAYER_RUN_FAILED";
      safe.observations = error?.observations ?? [];
      throw safe;
    }
  }
  async function processJob(id,session) {
    session.assertHeld();
    const fence = await leases.tryAcquireLease(id,session);
    if (!fence) return Object.freeze({ deliveryJobId: id,action: "BUSY",submitted: false });
    let stopped = false; let timer; let renewal; let failure;
    const renew = () => {
      if (stopped) return;
      renewal = leases.renewLease(fence).catch(error => { failure = error; }).finally(() => {
        if (!stopped && !failure) timer = setTimeout(renew,Math.max(1,Math.floor(config.leaseMs / 3)));
      });
    };
    const assertHeld = () => { session.assertHeld(); if (failure) throw failure; };
    timer = setTimeout(renew,Math.max(1,Math.floor(config.leaseMs / 3)));
    let primaryError;
    try {
      await afterLeaseAcquired(fence);
      assertHeld();
      const job = await queue.getDeliveryJob(id);
      if (job.status !== "READY" || job.deliveryJobId !== id) throw new RelayerError("RELAYER_REQUIRES_READY");
      const encoded = await encodeGatewaySubmission(await queue.getDeliveryPackage(id),verification);
      const pack = encoded.package;
      if (pack.deliveryJobId !== id || pack.message.destinationDomain !== config.destinationDomain.toString() ||
          job.destinationDomain !== pack.message.destinationDomain || normalizeAddress(job.destinationGateway) !== pack.message.destinationGateway) throw new RelayerError("DESTINATION_CONTEXT_MISMATCH");
      assertHeld();
      const prepared = await transactionManager.prepareDeliveryTransaction(id,{ fence });
      await afterPrepared({ fence,stored: prepared });
      assertHeld();
      if (prepared.historicalSubmission) return Object.freeze({ ...prepared,submitted: false,workerId: session.workerId });
      const result = await transactionManager.continueDeliveryTransactionOnce(id,{ fence });
      assertHeld();
      return Object.freeze({ ...result,workerId: session.workerId,fencingToken: fence.fencingToken });
    } catch (error) {
      primaryError = error;
      if (["SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST","EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST"].includes(error.code)) {
        primaryError = undefined;
        return Object.freeze({ deliveryJobId: id,action: "BLOCKED_BY_EARLIER_NONCE",submitted: false,workerId: session.workerId });
      }
      throw error;
    } finally {
      stopped = true; clearTimeout(timer); await renewal;
      try { await leases.releaseLease(fence); }
      catch (error) {
        // Lost/expired leases remain available for takeover. Cleanup never
        // releases a newer owner or hides the original processing failure.
        if (error.code !== "STALE_FENCE") {
          if (!primaryError) throw error;
          console.error(`Relayer lease cleanup also failed: ${safeRelayerMessage(error,config)}`);
        }
      }
    }
  }
  return {
    async submitJob(deliveryJobId) {
      return protectedOperation(() => leases.withWorker(session => processJob(deliveryJobId,session)));
    },
    async runOnce() {
      return protectedOperation(() => leases.withWorker(async session => {
        session.assertHeld();
        if (await transactionManager.verifyChain() !== config.destinationDomain) throw new RelayerError("CHAIN_ID_MISMATCH");
        const jobs = await leases.listClaimableJobs({ limit: config.maxJobs,session });
        const results = [];
        for (const job of jobs) results.push(await processJob(job.deliveryJobId,session));
        return Object.freeze({ workerId: session.workerId,relayerAddress: config.relayerAddress,destinationDomain: config.destinationDomain.toString(),
          selected: jobs.length,submitted: results.filter((result) => result.submitted).length,
          skipped: results.filter((result) => !result.submitted).length,results: Object.freeze(results) });
      }));
    },
  };
}
