import { loadRelayerConfig } from "../../src/relayer/config.mjs";
import { environment, developmentKeys } from "../../../validator/test/helpers/fixtures.mjs";

export function relayerEnvironment(overrides = {}) {
  const source = environment();
  return { DATABASE_URL: "postgresql://fixture:placeholder@127.0.0.1/unused",INDEXER_DB_SCHEMA: "relayer_fixture",
    CHAIN_A_DOMAIN: source.CHAIN_A_DOMAIN,SOURCE_GATEWAY_ADDRESS: source.SOURCE_GATEWAY_ADDRESS,
    VALIDATOR_SET_HISTORY_FILE: "",VALIDATOR_SET_HISTORY: source.VALIDATOR_SET_HISTORY,
    CHAIN_B_RPC_URL: "http://127.0.0.1:9545",CHAIN_B_CHAIN_ID: "2001",
    CHAIN_B_GENESIS_HASH: `0x${"12".repeat(32)}`,
    RELAYER_A_PRIVATE_KEY: developmentKeys(8)[7],RELAYER_MAX_JOBS_PER_RUN: "100",...overrides };
}

export function relayerConfig(overrides = {}) { return loadRelayerConfig(relayerEnvironment(overrides)); }
