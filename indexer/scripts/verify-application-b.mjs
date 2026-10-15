import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, http, parseAbiParameters, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress } from "../src/canonical-message.mjs";
import { developmentKeys } from "../../validator/test/helpers/fixtures.mjs";

const { CHAIN_B_RPC_URL: rpcUrl, APPLICATION_B_ADDRESS: applicationAddress,
  APPLICATION_B_GATEWAY_TEST_ADDRESS: gatewayAddress, APPLICATION_B_OTHER_GATEWAY_TEST_ADDRESS: otherGatewayAddress,
  APPLICATION_B_OPERATOR_KEY: operatorKey } = process.env;
assert.ok(rpcUrl && applicationAddress && gatewayAddress && otherGatewayAddress && operatorKey,
  "Chain B, production Application B, both test Gateway callers and the verification operator are required");
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) });
assert.equal(await client.getChainId(), 2001, "Application B must be verified on Chain B");
const address = normalizeAddress(applicationAddress);
const gateway = normalizeAddress(gatewayAddress);
const otherGateway = normalizeAddress(otherGatewayAddress);
assert.notEqual(gateway, otherGateway);
assert.notEqual(address, gateway, "the application receiver and Gateway authority are distinct");
assert.notEqual(address, otherGateway);
const artifact = (name) => JSON.parse(readFileSync(new URL(
  `../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
const application = artifact("ApplicationB");
const gatewayArtifact = artifact("MockDestinationGateway");
const gatewayAbi = [...gatewayArtifact.abi, ...application.abi.filter((item) => item.type === "error")];
const read = (functionName, args = []) => client.readContract({ address, abi: application.abi, functionName, args });
assert.equal(normalizeAddress(await read("destinationGateway")), gateway);
assert.equal(await read("COMMAND_VERSION"), 1);
assert.equal(await read("ACTION_GRANT_VERIFIED_SUPPLIER"), 1);
const codes = await Promise.all([gateway, otherGateway].map((target) =>
  client.request({ method: "eth_getCode", params: [target, "latest"] })));
assert.notEqual(codes[0], "0x");
assert.equal(codes[0], codes[1], "both test callers must have identical code at distinct addresses");

const fixture = JSON.parse(readFileSync(new URL("../../test-vectors/application-b-commands.json", import.meta.url), "utf8"));
assert.equal(fixture.abiTypes, "uint8,uint8,address");
assert.equal(fixture.payloadLength, 96);
assert.equal(fixture.vectors.length, 2);
const commandTypes = parseAbiParameters(fixture.abiTypes);
const command = (version, action, supplier) => encodeAbiParameters(commandTypes, [version, action, supplier]);
for (const vector of fixture.vectors) {
  assert.equal(vector.version, 1);
  assert.equal(vector.action, 1);
  assert.equal(vector.expectedPayload.length, 2 + fixture.payloadLength * 2);
  assert.equal(command(vector.version, vector.action, vector.supplier), vector.expectedPayload);
  console.log(`VALID: JS canonical Application B payload matches frozen ABI bytes / ${vector.name}`);
}
const [first, second] = fixture.vectors;
const suppliers = fixture.vectors.map((vector) => normalizeAddress(vector.supplier));
assert.notEqual(suppliers[0], suppliers[1]);
// Public local development key six is outside the validator directory and the Tx Manager's exclusive EOA.
const wallets = [operatorKey, developmentKeys(6)[5]].map((key) =>
  createWalletClient({ account: privateKeyToAccount(key), transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) }));
assert.notEqual(wallets[0].account.address, wallets[1].account.address);
await client.request({ method: "anvil_setBalance", params: [wallets[1].account.address, toHex(100n * 10n ** 18n)] });
const observers = [...suppliers, ...wallets.map((wallet) => normalizeAddress(wallet.account.address)), gateway, otherGateway];
assert.equal(new Set(observers).size, observers.length, "business suppliers and transport/caller identities must be distinct");
const state = () => Promise.all(observers.map((supplier) => read("isVerifiedSupplier", [supplier])));
assert.deepEqual(await state(), observers.map(() => false));
console.log(`Application B deployed: ${address}`);
console.log(`Trusted destination Gateway TEST HARNESS: ${gateway}`);
console.log(`Supplier before: ${suppliers[0]} VERIFIED_SUPPLIER = false`);
console.log("TEST FIXTURE: message IDs below are correlation labels, not claims of source/QC authentication or replay consumption");
const firstId = `0x${"11".repeat(32)}`;
const secondId = `0x${"22".repeat(32)}`;
// Isolated application-fixture budget, not a production Gateway gas/package limit.
const TEST_TRANSACTION_GAS = 1_000_000n;
const errorValue = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;
const direct = (messageId, payload) => ({ address, abi: application.abi,
  functionName: "handleCrossChainMessage", args: [messageId, payload] });
const forwarded = (target, messageId, payload) => ({ address: target, abi: gatewayAbi,
  functionName: "forwardMessage", args: [address, messageId, payload] });

async function transaction(parameters, wallet, expectedStatus) {
  const hash = await wallet.writeContract({ ...parameters, gas: TEST_TRANSACTION_GAS });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, expectedStatus, "Application B transaction status");
  assert.equal(receipt.from.toLowerCase(), wallet.account.address.toLowerCase());
  return receipt;
}

async function reject(parameters, errorName, args, label, wallet = wallets[0]) {
  const before = await state();
  await assert.rejects(() => client.simulateContract({ ...parameters, account: wallet.account }), (error) => {
    for (let cause = error; cause; cause = cause.cause) {
      if (cause.data?.errorName === errorName) {
        assert.deepEqual((cause.data.args ?? []).map(errorValue), args.map(errorValue), `${label}: exact custom-error arguments`);
        return true;
      }
    }
    return false;
  }, label);
  const receipt = await transaction(parameters, wallet, "reverted");
  assert.deepEqual(await state(), before, `${label}: all observed business state must remain unchanged`);
  assert.equal(receipt.logs.length, 0, `${label}: no successful grant event`);
  console.log(`EXPECTED FAILURE: Application B / ${label} (${errorName}); actual transaction reverted, state/events unchanged`);
}

async function grant(vector, messageId) {
  const supplier = normalizeAddress(vector.supplier);
  assert.equal(await read("isVerifiedSupplier", [supplier]), false);
  const parameters = forwarded(gateway, messageId, vector.expectedPayload);
  await client.simulateContract({ ...parameters, account: wallets[0].account });
  assert.equal(await read("isVerifiedSupplier", [supplier]), false, "preflight is not a business state commit");
  const receipt = await transaction(parameters, wallets[0], "success");
  assert.equal(await read("isVerifiedSupplier", [supplier]), true);
  assert.equal(receipt.logs.length, 1);
  const log = receipt.logs[0];
  assert.equal(normalizeAddress(log.address), address);
  const event = decodeEventLog({ abi: application.abi, data: log.data, topics: log.topics, strict: true });
  assert.equal(event.eventName, "VerifiedSupplierGranted");
  assert.equal(event.args.messageId, messageId);
  assert.equal(normalizeAddress(event.args.supplier), supplier);
  console.log(`VALID: exact trusted Gateway invoked production Application B / ${vector.name}`);
  console.log(`VALID: VerifiedSupplierGranted messageId=${messageId} supplier=${supplier}`);
  console.log(`Supplier after: ${supplier} VERIFIED_SUPPLIER = true`);
}

await reject(direct(firstId, first.expectedPayload), "UnauthorizedDestinationGateway",
  [wallets[0].account.address, gateway], "direct user EOA cannot grant supplier state");
await reject(direct(firstId, first.expectedPayload), "UnauthorizedDestinationGateway",
  [wallets[1].account.address, gateway], "Relayer-like EOA cannot grant supplier state", wallets[1]);
await reject(forwarded(otherGateway, firstId, first.expectedPayload), "UnauthorizedDestinationGateway",
  [otherGateway, gateway], "untrusted contract with identical Gateway code is still unauthorized");
await reject(direct(firstId, "0x"), "UnauthorizedDestinationGateway", [wallets[0].account.address, gateway],
  "caller authorization precedes malformed-payload decoding");
await reject(forwarded(gateway, firstId, command(2, 1, first.supplier)), "UnsupportedCommandVersion", [2n], "unsupported command version");
await reject(forwarded(gateway, firstId, command(1, 2, first.supplier)), "UnsupportedBusinessAction", [2n], "unsupported business action");
await reject(forwarded(gateway, firstId, command(1, 1, `0x${"00".repeat(20)}`)), "InvalidSupplier", [], "zero supplier");
for (const [label, payload] of [["empty payload", "0x"],
  ["truncated payload", `0x${first.expectedPayload.slice(2, -2)}`],
  ["trailing bytes", `${first.expectedPayload}00`],
  ["packed non-ABI command", `0x0101${first.supplier.slice(2)}`],
  ["wrapped dynamic bytes", encodeAbiParameters(parseAbiParameters("bytes"), [first.expectedPayload])]]) {
  await reject(forwarded(gateway, firstId, payload), "InvalidBusinessPayload", [], label);
}
const words = parseAbiParameters("uint256,uint256,uint256");
for (const [label, values] of [["dirty version padding", [256n, 1n, BigInt(first.supplier)]],
  ["dirty action padding", [1n, 256n, BigInt(first.supplier)]],
  ["dirty address padding", [1n, 1n, (1n << 160n) | BigInt(first.supplier)]]]) {
  await reject(forwarded(gateway, firstId, encodeAbiParameters(words, values)), "InvalidBusinessPayload", [], label);
}
await grant(first, firstId);
await reject(forwarded(gateway, firstId, first.expectedPayload), "AlreadyVerifiedSupplier", [first.supplier],
  "same supplier is a redundant business transition, not an Application B replay mapping");
await reject(forwarded(gateway, secondId, first.expectedPayload), "AlreadyVerifiedSupplier", [first.supplier],
  "another correlation ID cannot repeat the same supplier transition");
await grant(second, secondId);
assert.deepEqual(await state(), observers.map((_observer, index) => index < suppliers.length));
console.log("VALID: both explicit suppliers are verified independently; caller/Gateway identities were not inferred as suppliers");
console.log("VALID: Application B boundary only; replay storage, historical payloads, production Relayer target and transaction manager unchanged");
console.log("APPLICATION B BUSINESS VERIFICATION PASSED");
