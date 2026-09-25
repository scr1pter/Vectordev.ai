# Bundled provider SDKs

Vector includes reviewed AI SDK V3 implementations for Cloudflare AI Gateway, SAP AI Core, AIHubMix, Merge Gateway, IBM watsonx and QVAC. They work in both session engines without installing their SDKs at runtime. Catalog additions still require a reviewed Vector catalog release.

Keep provider keys in Vector's credential store or a process environment, rather than committing them to project configuration. The nonsecret settings below belong in the provider's `options` object in `vector.json`.

| Provider ID             | Connection settings                                                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare-ai-gateway` | `accountId`, `gatewayId`, and your API token. `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`, and `CLOUDFLARE_API_TOKEN` / `CF_AIG_TOKEN` are supported. Model IDs use `provider/model`.                                                                                               |
| `sap-ai-core`           | Your SAP service-key JSON, plus optional `deploymentId` and `resourceGroup`. Environment alternatives: `AICORE_SERVICE_KEY`, `AICORE_DEPLOYMENT_ID`, `AICORE_RESOURCE_GROUP`. Saved keys stay scoped to their SDK instance; Vector does not copy them into a shared process environment. |
| `aihubmix`              | Your API key (`AIHUBMIX_API_KEY`). An optional `baseURL` points to the host root; a trailing `/v1` is normalized. No publisher referral code is sent unless you explicitly set `appCode` or an `APP-Code` header.                                                                        |
| `merge-gateway`         | Your API key (`MERGE_GATEWAY_API_KEY`), using the SDK's default Merge AI SDK endpoint. A custom endpoint must implement the SDK's chat-completions protocol.                                                                                                                             |
| `watsonx`               | Your IBM API key (`WATSONX_AI_APIKEY`), `projectId` / `WATSONX_AI_PROJECT_ID`, and optional regional `baseURL`. IAM authentication uses IBM's fixed token endpoint.                                                                                                                      |
| `qvac`                  | An explicit `baseURL` for a QVAC server you already run, for example `http://127.0.0.1:11435/v1`. Vector does not install, download, start or manage a QVAC runtime.                                                                                                                     |

Cloudflare gateway metadata, cache TTL/key, cache bypass and request-log settings are forwarded to the gateway. Your configured transport receives the outer gateway request, including cancellation and timeout signals.

SAP uses the canonical `@jerome-benoit/sap-ai-provider` V3 package. Catalog entries using the previous V2 package name are normalized during catalog preparation. Service-key authentication uses HTTPS, refuses redirect-based token forwarding, and rejects request URL/transport overrides that could redirect saved credentials. An explicitly configured SAP destination remains available for enterprise setups.

Salad Cloud's published SDK requires the next major AI SDK protocol, so Vector does not advertise it as a bundled provider. The general OpenAI-compatible provider remains available for separately configured compatible endpoints.
