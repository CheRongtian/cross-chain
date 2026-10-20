import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { validateCanonicalMessage } from "../../src/canonical-message.mjs";
import { databaseRowToBatchMessage } from "../../src/message-batch.mjs";
import { deliveryJson } from "../../src/delivery/package.mjs";

const internalFields = new Set(["privatekey", "validatorprivatekey", "relayerprivatekey", "databaseurl",
  "sourcedatabaseurl", "validatordatabaseurl", "password", "connectionstring", "rawsignedtransaction",
  "ownersessionid", "witness", "privateinputs"]);

export function assertMessageQueryPrivacy(body, { source, privateKeys = [], connectionStrings = [], rawSignedTransactions = [] }) {
  const publicMessage = JSON.parse(deliveryJson(validateCanonicalMessage(databaseRowToBatchMessage(source), source.message_id)));
  assert.ok(isDeepStrictEqual(body.message, publicMessage), "HTTP canonical message must match persisted source evidence");
  const keys = privateKeys.filter(Boolean).map(value => value.toLowerCase());
  const connections = connectionStrings.filter(Boolean);
  const transactions = rawSignedTransactions.filter(Boolean);

  function inspect(value, path = "") {
    if (typeof value === "string") {
      assert.ok(connections.every(secret => !value.includes(secret)), "HTTP lifecycle responses must exclude connection material");
      assert.ok(transactions.every(secret => !value.includes(secret)), "HTTP lifecycle responses must exclude raw signed bytes");
      // Test signing scalars can equal an ABI word in an already-public payload.
      // Only this exact field, authenticated against source evidence above, is
      // exempt from the private-key substring check. Other paths stay checked.
      if (path !== "message.payload") {
        assert.ok(keys.every(secret => !value.toLowerCase().includes(secret)), "HTTP lifecycle responses must exclude private signing material");
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => inspect(entry, `${path}.${index}`));
    } else if (value && typeof value === "object") {
      for (const [field, entry] of Object.entries(value)) {
        assert.ok(!internalFields.has(field.replaceAll("_", "").toLowerCase()), "HTTP lifecycle responses must exclude internal configuration and signing fields");
        inspect(entry, path ? `${path}.${field}` : field);
      }
    }
  }
  inspect(body);
}
