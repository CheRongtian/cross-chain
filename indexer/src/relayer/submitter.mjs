import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress, normalizeBytes32 } from "../canonical-message.mjs";
import { RelayerError } from "./config.mjs";

// Historical direct-submission adapter. The production Relayer uses Transaction Manager.
export function createDirectRpcSubmitter(config) {
  const chain = defineChain({ id: Number(config.destinationDomain),name: "Configured destination",
    nativeCurrency: { name: "Ether",symbol: "ETH",decimals: 18 },rpcUrls: { default: { http: [config.destinationRpcUrl] } } });
  // The library performs one ordinary local-account send. Transport retries are disabled.
  const publicClient = createPublicClient({ chain,transport: http(config.destinationRpcUrl,{ retryCount: 0,timeout: 10000 }) });
  const wallet = createWalletClient({ chain,account: privateKeyToAccount(config.privateKey),
    transport: http(config.destinationRpcUrl,{ retryCount: 0,timeout: 10000 }) });
  return {
    async verifyChain() {
      const value = await publicClient.request({ method: "eth_chainId" });
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value) || BigInt(value) !== config.destinationDomain) throw new RelayerError("CHAIN_ID_MISMATCH");
      return config.destinationDomain;
    },
    async submit({ to,data,value }) {
      if (value !== 0n) throw new RelayerError("NONZERO_SUBMISSION_VALUE");
      await this.verifyChain();
      const hash = await wallet.sendTransaction({ to: normalizeAddress(to),data,value });
      return normalizeBytes32(hash,"transaction hash");
    },
  };
}
