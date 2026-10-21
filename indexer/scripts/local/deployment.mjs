// Local deployment mechanics reuse the compiled production contracts.
import assert from "node:assert/strict";
import { copyFile,mkdir,readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicClient,createWalletClient,http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT } from "./tools.mjs";
import { LOCAL_DEVELOPMENT_KEY } from "./config.mjs";

export const artifact = async name => JSON.parse(await readFile(join(ROOT,"contracts/out",name + ".sol",name + ".json"),"utf8"));
export function clients(url,id) {
  const chain = { id,name: "Owned local chain",nativeCurrency: { name: "Ether",symbol: "ETH",decimals: 18 },rpcUrls: { default: { http: [url] } } };
  return { publicClient: createPublicClient({ chain,transport: http(url,{ timeout: 10000 }),pollingInterval: 100 }),
    wallet: createWalletClient({ chain,account: privateKeyToAccount(LOCAL_DEVELOPMENT_KEY),transport: http(url,{ timeout: 10000 }) }) };
}
export async function successfulReceipt(client,hash) {
  const receipt = await client.waitForTransactionReceipt({ hash,timeout: 30000,pollingInterval: 100 });
  assert.equal(receipt.status,"success","local on-chain operation reverted");
  return receipt;
}
export async function writeContract(client,wallet,address,name,functionName,args) {
  return successfulReceipt(client,await wallet.writeContract({ address,abi: (await artifact(name)).abi,functionName,args }));
}
export async function snapshotArtifacts(directory) {
  const target = join(directory,"artifacts");
  await mkdir(target,{ recursive: true,mode: 0o700 });
  const paths = {
    wasm: ["zk/build/circuit/CredentialAuthorization_js/CredentialAuthorization.wasm","credential.wasm"],
    zkey: ["zk/build/proving/CredentialAuthorization_final.zkey","credential.zkey"],
    verificationKey: ["zk/build/proving/verification_key.json","verification-key.json"],
    verifier: ["contracts/out/Groth16Verifier.sol/Groth16Verifier.json","verifier.json"],
  };
  const result = {};
  for (const [key,[source,name]] of Object.entries(paths)) {
    result[key] = join(target,name);
    try { await copyFile(join(ROOT,source),result[key]); }
    catch { throw new Error(`Missing reusable ${source}; prepare the existing build/proof artifacts with ./scripts/verify.sh first`); }
  }
  return result;
}
export async function deployLocalProtocol(config,issuer,validators,artifacts,progress = console.log) {
  const a = clients(config.chainA,10011); const b = clients(config.chainB,2001);
  assert.equal(await a.publicClient.getChainId(),10011); assert.equal(await b.publicClient.getChainId(),2001);
  async function deploy(target,name,args = [],material) {
    const value = material ?? await artifact(name);
    const receipt = await successfulReceipt(target.publicClient,await target.wallet.deployContract({ abi: value.abi,bytecode: value.bytecode.object,args }));
    assert.ok(receipt.contractAddress);
    const code = await target.publicClient.getCode({ address: receipt.contractAddress });
    assert.ok(code && code !== "0x","deployed contract must have code");
    progress(`Deployed ${name}: ${receipt.contractAddress}`);
    return receipt.contractAddress.toLowerCase();
  }
  const admin = a.wallet.account.address;
  const groth16Verifier = await deploy(a,"Groth16Verifier",[],JSON.parse(await readFile(artifacts.verifier,"utf8")));
  const credentialVerifier = await deploy(a,"CredentialVerifier",[groth16Verifier]);
  const sourceGateway = await deploy(a,"SourceGateway",[admin]);
  const identityApplication = await deploy(a,"IdentityApplicationA",[credentialVerifier,sourceGateway,issuer.trustedIssuer,1n,3600n,admin,issuer.initialRoot]);
  await writeContract(a.publicClient,a.wallet,sourceGateway,"SourceGateway","setSourceApplicationAuthorization",[identityApplication,true]);
  const remoteRegistry = await deploy(b,"RemoteGatewayRegistry",[admin]);
  const validatorRegistry = await deploy(b,"ValidatorSetRegistry",[admin]);
  await writeContract(b.publicClient,b.wallet,validatorRegistry,"ValidatorSetRegistry","registerValidatorSet",[7n,validators]);
  const pbftVerifier = await deploy(b,"PBFTCertificateVerifier",[validatorRegistry]);
  const merkleVerifier = await deploy(b,"MerkleInclusionVerifier");
  const domainVerifier = await deploy(b,"MessageDomainVerifier",[remoteRegistry,2001n]);
  const destinationGateway = await deploy(b,"DestinationGateway",[pbftVerifier,merkleVerifier,domainVerifier]);
  const applicationB = await deploy(b,"ApplicationB",[destinationGateway]);
  await writeContract(b.publicClient,b.wallet,remoteRegistry,"RemoteGatewayRegistry","setRemoteGateway",[10011n,sourceGateway]);
  return { groth16Verifier,credentialVerifier,sourceGateway,identityApplication,remoteRegistry,validatorRegistry,pbftVerifier,merkleVerifier,domainVerifier,destinationGateway,applicationB };
}
