import { loadDeliveryConfig } from "../../src/delivery/config.mjs";
import { createDatabasePool } from "../../src/db.mjs";
import { createDeliveryProjector } from "../../src/delivery/projector.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { deliveryJson, verifyDeliveryPackage } from "../../src/delivery/package.mjs";

// Verification-only deterministic crash boundaries; production has no fault flag.
const config = loadDeliveryConfig();
const pool = createDatabasePool(config);
const [action,batchRecordId] = process.argv.slice(2);
try {
  if (action === "interrupt-before-commit") {
    const projector = createDeliveryProjector({ config,pool,afterJobPersisted: async ({ messageIndex }) => {
      if (messageIndex === 0) throw new Error("expected delivery interruption before commit");
    } });
    await projector.materializeBatch({ batchRecordId });
    throw new Error("interrupted projection unexpectedly succeeded");
  }
  if (action === "interrupt-after-commit") {
    await createDeliveryProjector({ config,pool }).materializeBatch({ batchRecordId });
    throw new Error("expected delivery interruption after durable commit before reporting");
  }
  let projection;
  if (action === "project") projection = await createDeliveryProjector({ config,pool }).projectCommittedBatches();
  else if (action !== "read") throw new Error("invalid delivery verification helper action");
  const reader = createDeliveryRepository({ config,pool });
  const jobs = await reader.listReadyDeliveryJobs();
  const packages = [];
  for (const job of jobs) {
    const pack = await reader.getDeliveryPackage(job.deliveryJobId);
    packages.push(await verifyDeliveryPackage(pack,{ validatorSets: config.validatorSets,
      sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway }));
  }
  process.stdout.write(deliveryJson({ projection,jobs,packages }));
} catch (error) {
  console.error(error.message.replaceAll(config.databaseUrl,"<redacted>"));
  process.exitCode = 1;
} finally { await pool.end(); }
