// This observation relies on the operator configuring the deployed, immutable
// production IdentityApplicationA. Its only outbound path verifies the exact
// intent proof before calling SourceGateway. No proof is reverified by GET.
export function observeSourceAuthorization(config, message, origin) {
  const matched = config.identityApplicationAddress && message.version === 2n &&
    message.sourceDomain === config.chainDomain && message.sourceGateway === config.sourceGateway &&
    message.sourceSender === config.identityApplicationAddress;
  return { status: matched ? origin.status === "REORGED" ? "HISTORICAL_AUTHORIZED" : "AUTHORIZED" : "UNAVAILABLE",
    basis: matched ? "CONFIGURED_PRODUCTION_APPLICATION_PATH" : null,
    application: matched ? message.sourceSender : null,
    sourceDomain: message.sourceDomain, sourceGateway: message.sourceGateway,
    transactionHash: origin.transactionHash, blockHash: origin.blockHash, logIndex: origin.logIndex,
    sourceStatus: origin.status };
}
