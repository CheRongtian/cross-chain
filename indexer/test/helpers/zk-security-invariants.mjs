import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, decodeEventLog, defineChain, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CREDENTIAL_PUBLIC_SIGNAL_ORDER } from "../../src/forward-authorization.mjs";
import { decodeCrossChainMessageLog } from "../../src/source-gateway-event.mjs";
import { normalizeAddress } from "../../src/canonical-message.mjs";
import { generateCredentialProof } from "../../../zk/scripts/forward-proof.mjs";
import { expectForwardRejection, prepareAuthorizedSourceMessage } from "./authorized-source-message.mjs";

const json = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const artifact = name => json(`../../../contracts/out/${name}.sol/${name}.json`);
const asArguments = proof => [proof.proofA.map(BigInt), proof.proofB.map(row => row.map(BigInt)), proof.proofC.map(BigInt),
  Object.fromEntries(Object.entries(proof.publicInputs).map(([name, value]) => [name, BigInt(value)]))];
const otherExecutor = "0x0000000000000000000000000000000000000123";

function exactRevert(error, reason) {
  const cause = error?.walk?.(value => value.name === "ContractFunctionRevertedError");
  return cause?.name === "ContractFunctionRevertedError" && cause.data?.errorName === reason;
}

async function context() {
  const rpcUrl = process.env.CHAIN_A_RPC_URL;
  const application = process.env.IDENTITY_APPLICATION_ADDRESS;
  const privateKey = process.env.VERIFIER_DEPLOYER_KEY;
  assert.ok(rpcUrl && application && privateKey, "ZK verification requires the existing Chain A deployment context");
  const [applicationArtifact, gatewayArtifact, verifierArtifact] = await Promise.all([
    artifact("IdentityApplicationA"), artifact("SourceGateway"), artifact("CredentialVerifier"),
  ]);
  const account = privateKeyToAccount(privateKey);
  const probe = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 });
  const chainId = await probe.getChainId();
  const chain = defineChain({ id: chainId, name: "Verification Chain A",
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl), cacheTime: 0 });
  const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
  const abi = applicationArtifact.abi;
  const read = (name, args = [], target = application, blockNumber) => publicClient.readContract({ address: target, abi,
    functionName: name, args, ...(blockNumber === undefined ? {} : { blockNumber }) });
  const gateway = await read("sourceGateway");
  const verifier = await read("credentialVerifier");
  const startBlock = await publicClient.getBlockNumber();
  const scheduleExecution = async timestamp => {
    assert.ok(timestamp > (await publicClient.getBlock()).timestamp, "controlled execution must advance chain time");
    await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [toHex(timestamp)] });
  };
  const assertExecutionTime = async (receipt, timestamp) => {
    if (timestamp !== undefined) {
      assert.equal((await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp, timestamp,
        "the actual transaction must be mined at the exact requested boundary");
    }
  };
  const transaction = async (name, args = [], target = application, executionTimestamp) => {
    if (executionTimestamp !== undefined) await scheduleExecution(executionTimestamp);
    const hash = await walletClient.writeContract({ address: target, abi, functionName: name, args, gas: 3_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${name}: positive/admin transaction must succeed`);
    await assertExecutionTime(receipt, executionTimestamp);
    return receipt;
  };
  const cryptoValid = async proof => {
    assert.equal(await publicClient.readContract({ address: verifier, abi: verifierArtifact.abi,
      functionName: "verifyCredentialProof", args: asArguments(proof) }), true, "real Solidity verifier must accept the proof first");
  };
  const isolated = async run => {
    const snapshot = await publicClient.request({ method: "evm_snapshot" });
    let failure;
    try { return await run(); }
    catch (error) { failure = error; throw error; }
    finally {
      try { assert.equal(await publicClient.request({ method: "evm_revert", params: [snapshot] }), true, "restore owned verification snapshot"); }
      catch (error) {
        if (!failure) throw error;
        console.error("ZK verification snapshot restoration failed:", error);
      }
    }
  };
  const advanceTo = async timestamp => {
    assert.ok(timestamp > (await publicClient.getBlock()).timestamp, "verification time advance must be explicit and forward");
    await publicClient.request({ method: "evm_setNextBlockTimestamp", params: [toHex(timestamp)] });
    await publicClient.request({ method: "evm_mine" });
    assert.equal((await publicClient.getBlock()).timestamp, timestamp);
  };
  // Pin every state read to one block and include both Application and Gateway
  // event histories. A reverted transaction may advance a block, but no state
  // or business/source log may change. Admin changes precede these snapshots.
  const capture = async (proofs, target = application) => {
    const blockNumber = await publicClient.getBlockNumber();
    const nullifiers = [...new Set(proofs.map(proof => proof.publicInputs.nullifier.toString()))].sort();
    const commitments = [...new Set(proofs.map(proof => proof.publicInputs.credentialCommitment.toString()))].sort();
    const targetGateway = await read("sourceGateway", [], target, blockNumber);
    const [root, epoch, nonce, consumed, status, logs] = await Promise.all([
      read("credentialStateRoot", [], target, blockNumber), read("currentPolicyEpoch", [], target, blockNumber),
      publicClient.readContract({ address: targetGateway, abi: gatewayArtifact.abi, functionName: "nextNonce", blockNumber }),
      Promise.all(nullifiers.map(value => read("usedNullifiers", [BigInt(value)], target, blockNumber))),
      Promise.all(commitments.map(value => read("authorizationStatus", [BigInt(value)], target, blockNumber))),
      publicClient.getLogs({ address: [target, targetGateway], fromBlock: startBlock, toBlock: blockNumber }),
    ]);
    return { root, epoch, nonce, nullifiers, consumed, commitments, status,
      logs: logs.map(log => ({ address: normalizeAddress(log.address), transactionHash: log.transactionHash,
        logIndex: log.logIndex, topics: [...log.topics], data: log.data })) };
  };
  const rejected = async (proof, name, reason, { request, caller = account.address, target = application, history = [], executionTimestamp } = {}) => {
    const before = await capture([proof, ...history], target);
    const args = [...asArguments(proof), ...(request ? [request] : [])];
    if (executionTimestamp !== undefined) {
      // A future controlled block is checked at its actual canonical receipt
      // below. A preflight against today's block would test a different policy.
      assert.equal(normalizeAddress(caller), normalizeAddress(account.address));
    } else if (name === "forwardAuthorizedMessage") {
      await expectForwardRejection(publicClient, target, { abi }, args, caller, reason);
    } else {
      await assert.rejects(publicClient.simulateContract({ address: target, abi, functionName: name, args, account: caller }),
        error => exactRevert(error, reason), `${name}: require exact ${reason}`);
    }
    // The alternate executor is deliberately unowned. Its simulation tests
    // digest binding; ordinary cases also submit a real reverting transaction.
    if (normalizeAddress(caller) === normalizeAddress(account.address)) {
      if (executionTimestamp !== undefined) await scheduleExecution(executionTimestamp);
      const hash = await walletClient.writeContract({ address: target, abi, functionName: name, args, gas: 3_000_000n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "reverted", `${name}: rejected transaction cannot succeed`);
      assert.equal(receipt.logs.length, 0, "rejected transaction has no authorization or source events");
      await assertExecutionTime(receipt, executionTimestamp);
      assert.ok(receipt.gasUsed < 3_000_000n, "an exhausted transaction gas budget cannot credit policy rejection");
      await assert.rejects(publicClient.simulateContract({ address: target, abi, functionName: name, args, account: caller,
        gas: 3_000_000n, blockNumber: receipt.blockNumber }), error => exactRevert(error, reason),
      "the same bounded call at the actual execution block must retain the precise rejection reason");
    }
    assert.deepEqual(await capture([proof, ...history], target), before, `${reason}: no nullifier/status/root/epoch/nonce/event changes`);
    console.log(`EXPECTED FAILURE: ${name} ${reason}; complete authorization/source state unchanged`);
  };
  const forward = async options => prepareAuthorizedSourceMessage({ publicClient, application,
    destinationDomain: 2001n, destinationGateway: "0x000000000000000000000000000000000000d00d",
    destinationReceiver: "0x000000000000000000000000000000000000beef", payload: "0x68656c6c6f20636861696e2062",
    deadline: (await publicClient.getBlock()).timestamp + 7200n, executor: account.address, ...options });
  return { publicClient, walletClient, account, application, applicationArtifact, gatewayArtifact, verifierArtifact,
    chainId, abi, gateway, verifier, read, transaction, cryptoValid, isolated, advanceTo, capture, rejected, forward };
}

async function loadProof(name) {
  const proof = await json(`../../../zk/build/proving/solidity-calldata/${name}.json`);
  return { ...proof, publicInputs: Object.fromEntries(CREDENTIAL_PUBLIC_SIGNAL_ORDER.map(key => [key, BigInt(proof.publicInputs[key])])) };
}

function applicationLogs(receipt, ctx) {
  return receipt.logs.filter(log => normalizeAddress(log.address) === normalizeAddress(ctx.application))
    .map(log => decodeEventLog({ abi: ctx.abi, topics: log.topics, data: log.data }));
}

async function applicationInvariants(ctx) {
  const { publicClient, walletClient, application, gateway, account, read, transaction, cryptoValid, isolated, rejected, forward } = ctx;
  const names = ["valid", "valid-replay", "active-secondary-initial", "active-secondary-current", "application-next-epoch",
    "application-alternate-issuer", "application-auditor-role", "tampered-proof", "authorization-renewed", "authorization-short", "legacy-proof"];
  const proofs = new Map(await Promise.all(names.map(async name => [name, await loadProof(name)])));
  const valid = proofs.get("valid");
  const secondary = proofs.get("active-secondary-initial");
  const history = [valid, secondary];
  await isolated(async () => {
    assert.equal(await read("currentPolicyEpoch"), 1n);
    assert.equal(await read("credentialStateRoot"), valid.publicInputs.credentialStateRoot);
    assert.ok((await publicClient.getBlock()).timestamp < valid.publicInputs.currentTimestamp);
    await cryptoValid(valid);
    await rejected(valid, "verifySupplier", "FutureProofTimestamp", { history });
    await ctx.advanceTo(valid.publicInputs.currentTimestamp + 1n);
    // Exercise the short chosen window immediately after the explicit time
    // setup, before the longer real-proof/transaction matrix.
    await isolated(async () => {
      const proof = proofs.get("authorization-short");
      await cryptoValid(proof);
      assert.ok(proof.publicInputs.authorizationValidUntil - proof.publicInputs.currentTimestamp <= await read("maxProofAge"));
      await rejected(proof, "verifySupplier", "AuthorizationExpired", {
        history, executionTimestamp: proof.publicInputs.authorizationValidUntil,
      });
      console.log("EXPECTED FAILURE: a fresh proof cannot execute when its independently chosen authorization deadline is reached");
    });
    for (const [name, proof] of proofs) if (name !== "tampered-proof" && name !== "legacy-proof") await cryptoValid(proof);
    console.log("VALID: regenerated Groth16 verifier accepts the new 12-signal valid credential proof");
    for (const event of ctx.abi.filter(entry => entry.type === "event")) {
      assert.ok(event.inputs.every(input => !["expiry", "credentialExpiry", "subject", "credentialId", "statePathElements", "statePathIndices"].includes(input.name)));
    }
    assert.equal(Object.hasOwn(valid.publicInputs, "expiry"), false);
    assert.equal(Object.keys(valid.publicInputs).length, 12);
    console.log("VALID: exact private credential expiry is absent from public signals, calldata-derived authorization data and authorization events");

    await isolated(async () => {
      const before = await ctx.capture(history);
      const receipt = await transaction("verifySupplier", asArguments(valid));
      assert.equal(await read("authorizationStatus", [valid.publicInputs.credentialCommitment]), 1);
      assert.equal(await read("usedNullifiers", [valid.publicInputs.nullifier]), true);
      const logs = applicationLogs(receipt, ctx);
      assert.deepEqual(logs.map(log => log.eventName), ["NullifierConsumed", "SupplierVerified"]);
      assert.equal(logs[0].args.nullifier, valid.publicInputs.nullifier);
      assert.equal(logs[0].args.credentialCommitment, valid.publicInputs.credentialCommitment);
      assert.equal(logs[0].args.policyEpoch, valid.publicInputs.policyEpoch);
      assert.equal(logs[0].args.actionContext, valid.publicInputs.actionContext);
      assert.equal(logs[1].args.credentialCommitment, valid.publicInputs.credentialCommitment);
      assert.equal(normalizeAddress(logs[1].args.submitter), normalizeAddress(account.address));
      assert.equal(logs[1].args.proofTimestamp, valid.publicInputs.currentTimestamp);
      assert.equal((await ctx.capture(history)).nonce, before.nonce);
      await transaction("verifySupplier", asArguments(secondary));
      assert.equal(await read("authorizationStatus", [secondary.publicInputs.credentialCommitment]), 1);
      assert.equal(await read("usedNullifiers", [secondary.publicInputs.nullifier]), true);
      console.log("VALID: valid credential proof succeeds; independent A/B authorization, exact public-only events and consumed nullifiers");
      await rejected(valid, "verifySupplier", "NullifierAlreadyUsed", { history });
      const regenerated = proofs.get("valid-replay");
      assert.deepEqual(regenerated.publicInputs, valid.publicInputs);
      await cryptoValid(regenerated);
      await rejected(regenerated, "verifySupplier", "NullifierAlreadyUsed", { history });
      const renewed = proofs.get("authorization-renewed");
      assert.equal(renewed.publicInputs.nullifier, valid.publicInputs.nullifier);
      assert.notEqual(renewed.publicInputs.authorizationValidUntil, valid.publicInputs.authorizationValidUntil);
      await cryptoValid(renewed);
      await rejected(renewed, "verifySupplier", "NullifierAlreadyUsed", { history });
      console.log("EXPECTED FAILURE: changing only authorizationValidUntil cannot reset the standalone nullifier");
      console.log("EXPECTED FAILURE: reused nullifier, exact and independently regenerated valid proof (NULLIFIER_REPLAY_REJECTED)");
    });

    const impersonation = structuredClone(valid);
    impersonation.publicInputs.credentialCommitment = secondary.publicInputs.credentialCommitment;
    await rejected(impersonation, "verifySupplier", "InvalidCredentialProof", { history });
    await rejected(proofs.get("tampered-proof"), "verifySupplier", "InvalidCredentialProof", { history });
    const legacy = proofs.get("legacy-proof");
    assert.equal(await publicClient.readContract({ address: ctx.verifier, abi: ctx.verifierArtifact.abi,
      functionName: "verifyCredentialProof", args: asArguments(legacy) }), false);
    await rejected({ ...legacy, publicInputs: { ...valid.publicInputs } }, "verifySupplier", "InvalidCredentialProof", { history });
    console.log("EXPECTED FAILURE: legacy 11-signal proof rejected cryptographically by the production authorization path, with no fallback");
    console.log("EXPECTED FAILURE: wrong credential (INVALID_PROOF); valid B is accepted independently");
    for (const [name, reason] of [["application-alternate-issuer", "InvalidIssuerPolicy"], ["application-auditor-role", "InvalidRolePolicy"]]) {
      const proof = proofs.get(name);
      await cryptoValid(proof);
      await rejected(proof, "verifySupplier", reason, { history });
      console.log(`EXPECTED FAILURE: ${name === "application-alternate-issuer" ? "wrong issuer" : "wrong role"} (valid Groth16, POLICY_REJECTED)`);
    }
    const reasons = ["InvalidCredentialProof", "InvalidIssuerPolicy", "InvalidRolePolicy", "InvalidCredentialProof",
      "InvalidCredentialStateRoot", "InvalidApplicationDomain", "InvalidPolicyEpoch", "InvalidActionContext",
      "InvalidCredentialProof", "InvalidForwardIntent", "InvalidForwardIntent", "InvalidCredentialProof"];
    const field = BigInt((await json("../../../zk/encoding.json")).scalarField.prime);
    for (const [index, name] of CREDENTIAL_PUBLIC_SIGNAL_ORDER.entries()) {
      const proof = structuredClone(valid);
      proof.publicInputs[name] = (proof.publicInputs[name] + 1n) % field;
      assert.equal(await publicClient.readContract({ address: ctx.verifier, abi: ctx.verifierArtifact.abi,
        functionName: "verifyCredentialProof", args: asArguments(proof) }), false, `${name}: actual adapter mapping/binding`);
      await rejected(proof, "verifySupplier", reasons[index], { history });
      console.log(`EXPECTED FAILURE: modified public input ${name} (INVALID_PROOF; application ${reasons[index]})`);
    }
    await cryptoValid(valid);

    // Policy freshness uses a genuinely valid, unused proof. EVM snapshots
    // separate each time-policy mutation from the negative-attempt snapshot.
    await isolated(async () => {
      const proof = proofs.get("application-next-epoch");
      await transaction("advancePolicyEpoch");
      await ctx.advanceTo(proof.publicInputs.currentTimestamp + await read("maxProofAge") + 1n);
      assert.ok((await publicClient.getBlock()).timestamp < proof.publicInputs.authorizationValidUntil);
      await cryptoValid(proof);
      await rejected(proof, "verifySupplier", "StaleProofTimestamp", { history });
      console.log("EXPECTED FAILURE: stale proof is rejected while authorizationValidUntil remains in the future");
    });

    await isolated(async () => {
      await transaction("verifySupplier", asArguments(valid));
      await transaction("verifySupplier", asArguments(secondary));
      await transaction("advancePolicyEpoch");
      const nextEpoch = proofs.get("application-next-epoch");
      await transaction("verifySupplier", asArguments(nextEpoch));
      assert.equal(await read("usedNullifiers", [valid.publicInputs.nullifier]), true);
      assert.equal(await read("usedNullifiers", [nextEpoch.publicInputs.nullifier]), true);
      const historical = await forward({ payload: "0x03", fixtureName: "valid.json", stateName: "root-n" });
      await cryptoValid(historical);
      const historicalReceipt = await transaction("forwardAuthorizedMessage", historical.args);
      const unused = await forward({ fixtureName: "valid.json", stateName: "root-n" });
      await cryptoValid(unused);
      await publicClient.simulateContract({ address: application, abi: ctx.abi, functionName: "forwardAuthorizedMessage", args: unused.args, account });
      assert.equal(await read("usedNullifiers", [BigInt(unused.publicInputs.nullifier)]), false);
      const savedProof = structuredClone(unused);
      const rootAfter = proofs.get("active-secondary-current").publicInputs.credentialStateRoot;
      await transaction("updateCredentialStateRoot", [rootAfter, [valid.publicInputs.credentialCommitment]]);
      assert.equal(await read("authorizationStatus", [valid.publicInputs.credentialCommitment]), 2);
      assert.equal(await read("isVerifiedSupplier", [valid.publicInputs.credentialCommitment]), false);
      assert.equal(await read("isVerifiedSupplier", [secondary.publicInputs.credentialCommitment]), true);
      // Epoch/action/intent remain correct and the nullifier is unused. Only
      // the authority's real root/revocation transition removes acceptance.
      await cryptoValid(unused);
      await rejected(unused, "forwardAuthorizedMessage", "InvalidCredentialStateRoot", { request: unused.request, history: [...history, nextEpoch, historical] });
      assert.deepEqual(unused, savedProof, "revocation never rewrites historical proof evidence");
      const currentB = proofs.get("active-secondary-current");
      await transaction("verifySupplier", asArguments(currentB));
      assert.equal(await read("usedNullifiers", [currentB.publicInputs.nullifier]), true);
      for (const proof of [...history, nextEpoch, historical]) assert.equal(await read("usedNullifiers", [BigInt(proof.publicInputs.nullifier)]), true);
      const retained = await publicClient.getTransactionReceipt({ hash: historicalReceipt.transactionHash });
      assert.equal(retained.status, "success");
      assert.deepEqual(retained.logs, historicalReceipt.logs, "revocation retains the original canonical source message and authorization events");
      console.log("EXPECTED FAILURE: revoked credential with unused exact-intent context (POLICY_REJECTED); B works under new root and old nullifiers/logs persist");
    });

    await isolated(async () => {
      const prepared = await forward({ fixtureName: "valid.json", stateName: "root-n" });
      await cryptoValid(prepared);
      for (const [name, value] of [["destinationDomain", prepared.request.destinationDomain + 1n],
        ["destinationGateway", otherExecutor], ["destinationReceiver", otherExecutor], ["payload", "0x01"],
        ["deadline", prepared.request.deadline + 1n]]) {
        assert.notEqual(value, prepared.request[name]);
        await rejected(prepared, "forwardAuthorizedMessage", "InvalidForwardIntent", {
          request: { ...prepared.request, [name]: value }, history });
      }
      await rejected(prepared, "forwardAuthorizedMessage", "InvalidForwardIntent", { request: prepared.request, caller: otherExecutor, history });
      for (const [name, fixtureName, reason] of [
        ["application-alternate-issuer", "untrusted-issuer.json", "InvalidIssuerPolicy"],
        ["application-auditor-role", "wrong-role.json", "InvalidRolePolicy"],
      ]) {
        const policy = proofs.get(name).publicInputs;
        const alternative = await generateCredentialProof({ ...prepared.publicInputs, intent: prepared.intent,
          trustedIssuer: policy.trustedIssuer, requiredRole: policy.requiredRole, fixtureName, stateName: "root-n" });
        await cryptoValid(alternative);
        await rejected(alternative, "forwardAuthorizedMessage", reason, { request: prepared.request, history });
      }
      await rejected(valid, "forwardAuthorizedMessage", "InvalidActionContext", { request: prepared.request, history });
      await rejected(prepared, "verifySupplier", "InvalidActionContext", { history });
      const nonceBefore = (await ctx.capture(history)).nonce;
      const receipt = await transaction("forwardAuthorizedMessage", prepared.args);
      const sourceLogs = receipt.logs.filter(log => normalizeAddress(log.address) === normalizeAddress(gateway));
      assert.equal(sourceLogs.length, 1);
      const event = decodeCrossChainMessageLog(sourceLogs[0], { expectedGateway: normalizeAddress(gateway), expectedSourceDomain: BigInt(ctx.chainId) });
      assert.equal(event.nonce, nonceBefore);
      assert.equal(event.payload, prepared.request.payload);
      assert.equal(event.deadline, prepared.request.deadline);
      assert.equal(event.sourceSender, normalizeAddress(application));
      assert.equal(event.destinationDomain, prepared.request.destinationDomain);
      assert.equal(event.destinationGateway, normalizeAddress(prepared.request.destinationGateway));
      assert.equal(event.destinationReceiver, normalizeAddress(prepared.request.destinationReceiver));
      const logs = applicationLogs(receipt, ctx);
      assert.deepEqual(logs.map(log => log.eventName), ["NullifierConsumed", "AuthorizedMessageForwarded"]);
      assert.equal(logs[1].args.messageId, event.messageId);
      assert.equal(logs[1].args.intentDigest, prepared.intentDigest);
      assert.equal(logs[0].args.nullifier, BigInt(prepared.publicInputs.nullifier));
      assert.equal(await read("usedNullifiers", [BigInt(prepared.publicInputs.nullifier)]), true);
      assert.equal(await read("authorizationStatus", [valid.publicInputs.credentialCommitment]), 0, "forwarding grants no stored supplier status");
      assert.equal((await ctx.capture(history)).nonce, nonceBefore + 1n);
      await rejected(prepared, "forwardAuthorizedMessage", "NullifierAlreadyUsed", { request: prepared.request, history });
      const regenerated = await generateCredentialProof({ ...prepared.publicInputs, intent: prepared.intent,
        fixtureName: "valid.json", stateName: "root-n" });
      assert.deepEqual(asArguments(regenerated)[3], asArguments(prepared)[3]);
      await cryptoValid(regenerated);
      await rejected(regenerated, "forwardAuthorizedMessage", "NullifierAlreadyUsed", { request: prepared.request, history });
      const renewed = await generateCredentialProof({ ...prepared.publicInputs, intent: prepared.intent,
        authorizationValidUntil: BigInt(prepared.publicInputs.authorizationValidUntil) + 1n, fixtureName: "valid.json", stateName: "root-n" });
      assert.equal(renewed.publicInputs.nullifier, prepared.publicInputs.nullifier);
      await cryptoValid(renewed);
      await rejected(renewed, "forwardAuthorizedMessage", "NullifierAlreadyUsed", { request: prepared.request, history });
      console.log("EXPECTED FAILURE: changing only authorizationValidUntil cannot replay an already consumed forwarding intent");
      const independent = await forward({ payload: "0x02", fixtureName: "valid.json", stateName: "root-n" });
      assert.notEqual(independent.publicInputs.nullifier, prepared.publicInputs.nullifier);
      await transaction("forwardAuthorizedMessage", independent.args);
      await transaction("verifySupplier", asArguments(valid));
      assert.equal(await read("usedNullifiers", [valid.publicInputs.nullifier]), true);
      assert.equal(await read("usedNullifiers", [BigInt(prepared.publicInputs.nullifier)]), true);
      assert.equal(await read("usedNullifiers", [BigInt(independent.publicInputs.nullifier)]), true);
      assert.equal((await ctx.capture(history)).nonce, nonceBefore + 2n);
      console.log("VALID: exact-intent forwarding emits one canonical message; legal independent intent/action contexts remain usable");
      console.log("EXPECTED FAILURE: reused forwarding nullifier for exact/regenerated valid proof; no second message or nonce increment");
    });

    await isolated(async () => {
      const hash = await walletClient.deployContract({ abi: ctx.applicationArtifact.abi, bytecode: ctx.applicationArtifact.bytecode.object,
        args: [ctx.verifier, gateway, valid.publicInputs.trustedIssuer, valid.publicInputs.requiredRole, await read("maxProofAge"),
          account.address, valid.publicInputs.credentialStateRoot] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, "success");
      const target = receipt.contractAddress;
      assert.ok(target);
      await rejected(valid, "verifySupplier", "InvalidApplicationDomain", { target, history });
      const other = await generateCredentialProof({ ...valid.publicInputs, applicationDomain: await read("applicationDomain", [], target),
        fixtureName: "valid.json", stateName: "root-n" });
      assert.notEqual(BigInt(other.publicInputs.nullifier), valid.publicInputs.nullifier);
      await cryptoValid(other);
      await transaction("verifySupplier", asArguments(other), target);
      assert.equal(await read("usedNullifiers", [BigInt(other.publicInputs.nullifier)], target), true);
      assert.equal(await read("usedNullifiers", [valid.publicInputs.nullifier]), false);
      await rejected(other, "verifySupplier", "InvalidApplicationDomain", { history });
      console.log("VALID: independent application context authorizes locally; cross-application proof reuse is POLICY_REJECTED");
    });
    console.log("ZK APPLICATION INVARIANTS PASSED; execution-time expiry remains a required final gate");
  });
}

// Preserve the exact former exploit under the upgraded statement. Both proofs
// stay valid; exact canonical transaction timestamps determine acceptance.
async function executionTimeExpiry(ctx) {
  await ctx.isolated(async () => {
    const credential = await json("../../../zk/credential-model/fixtures/active-secondary.json");
    const expiry = BigInt(credential.expiry);
    const age = await ctx.read("maxProofAge");
    assert.ok(age >= 2n, "the existing verification profile must keep equality/after cases fresh");
    // A real authority operation supplies an unused standalone context as well
    // as an unused exact intent. It precedes every negative-attempt snapshot.
    await ctx.transaction("advancePolicyEpoch");
    const prepared = await ctx.forward({ proofTimestamp: expiry - 1n, authorizationValidUntil: expiry, deadline: expiry + 7200n });
    const standalone = await generateCredentialProof(prepared.publicInputs);
    await ctx.cryptoValid(prepared);
    await ctx.cryptoValid(standalone);
    assert.equal(BigInt(prepared.publicInputs.currentTimestamp), expiry - 1n);
    assert.equal(BigInt(prepared.publicInputs.authorizationValidUntil), expiry);
    const history = [prepared, standalone];
    for (const [proof, name, request] of [[prepared, "forwardAuthorizedMessage", prepared.request], [standalone, "verifySupplier", undefined]]) {
      assert.equal(BigInt(proof.publicInputs.currentTimestamp), expiry - 1n);
      assert.equal(BigInt(proof.publicInputs.authorizationValidUntil), expiry);
      assert.equal(await ctx.read("usedNullifiers", [BigInt(proof.publicInputs.nullifier)]), false);
      await ctx.isolated(async () => {
        const before = await ctx.capture(history);
        const args = [...asArguments(proof), ...(request ? [request] : [])];
        const receipt = await ctx.transaction(name, args, ctx.application, expiry - 1n);
        assert.equal(await ctx.read("usedNullifiers", [BigInt(proof.publicInputs.nullifier)]), true);
        const logs = applicationLogs(receipt, ctx);
        assert.deepEqual(logs.map(log => log.eventName), ["NullifierConsumed", request ? "AuthorizedMessageForwarded" : "SupplierVerified"]);
        const sourceLogs = receipt.logs.filter(log => normalizeAddress(log.address) === normalizeAddress(ctx.gateway));
        assert.equal(sourceLogs.length, request ? 1 : 0);
        const after = await ctx.capture(history);
        assert.equal(after.nonce, before.nonce + (request ? 1n : 0n));
        if (request) {
          const event = decodeCrossChainMessageLog(sourceLogs[0], { expectedGateway: normalizeAddress(ctx.gateway), expectedSourceDomain: BigInt(ctx.chainId) });
          assert.equal(event.payload, request.payload);
          assert.equal(event.deadline, request.deadline);
          assert.equal(event.nonce, before.nonce);
          assert.equal(logs[1].args.messageId, event.messageId);
          assert.equal(logs[1].args.intentDigest, prepared.intentDigest);
        } else assert.equal(await ctx.read("isVerifiedSupplier", [BigInt(proof.publicInputs.credentialCommitment)]), true);
        console.log(`VALID: ${name} with a fresh one-second-window proof executes exactly one second before authorizationValidUntil`);
      });
      for (const offset of [0n, 1n]) {
        await ctx.isolated(async () => {
          assert.ok(expiry + offset - BigInt(proof.publicInputs.currentTimestamp) <= age);
          await ctx.rejected(proof, name, "AuthorizationExpired", { request, history, executionTimestamp: expiry + offset });
          console.log(`EXPECTED FAILURE: ${name} at ${offset === 0n ? "exactly" : "one second after"} authorizationValidUntil; proof remains valid and fresh, complete state unchanged`);
        });
      }
    }
    console.log("VALID: former expiry-window exploit is closed: proofTimestamp=expiry-1 and authorizationValidUntil=expiry remains cryptographically valid, but execution at expiry is rejected with nullifier unused and SourceGateway nonce unchanged");
    console.log("VALID: per-proof authorization deadlines preserve near-expiry credential use without a fixed circuit buffer or private-expiry disclosure");
  });
}

const phase = process.argv[2];
assert.ok(phase === "application" || phase === "expiry", "expected application or expiry verification phase");
const ctx = await context();
if (phase === "application") await applicationInvariants(ctx);
else await executionTimeExpiry(ctx);
