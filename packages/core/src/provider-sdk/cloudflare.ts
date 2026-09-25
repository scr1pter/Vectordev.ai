import os from "os"
import { InstallationVersion } from "../installation/version"
import { ProviderSDK } from "../provider-sdk"

export async function cloudflareFactory(): Promise<ProviderSDK.Factory> {
  const { createAiGateway } = await import("ai-gateway-provider")
  const { createUnified } = await import("ai-gateway-provider/providers/unified")
  return (options) => {
    const accountId = ProviderSDK.string(options, "accountId") ?? process.env.CLOUDFLARE_ACCOUNT_ID
    const gateway =
      ProviderSDK.string(options, "gatewayId") ??
      ProviderSDK.string(options, "gateway") ??
      process.env.CLOUDFLARE_GATEWAY_ID
    const apiKey = ProviderSDK.string(options, "apiKey") ?? process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_AIG_TOKEN
    if (!accountId || !gateway || !apiKey)
      throw new Error("Cloudflare AI Gateway requires accountId, gatewayId and an API token")
    if (!/^[a-zA-Z0-9_-]+$/.test(accountId) || !/^[a-zA-Z0-9_-]+$/.test(gateway))
      throw new Error("Cloudflare accountId and gatewayId must be path identifiers")
    const headers = new Headers(options.headers as HeadersInit | undefined)
    const metadata =
      options.metadata ??
      (headers.get("cf-aig-metadata") ? ProviderSDK.parseJSON(headers.get("cf-aig-metadata")) : undefined)
    const sdk = createAiGateway({
      accountId,
      gateway,
      apiKey,
      fetch: options.fetch as typeof fetch | undefined,
      headers: {
        ...Object.fromEntries(headers),
        "User-Agent": `vector/${InstallationVersion} cloudflare-ai-gateway (${os.platform()} ${os.release()}; ${os.arch()})`,
      },
      options: {
        metadata,
        cacheTtl: options.cacheTtl,
        cacheKey: options.cacheKey,
        skipCache: options.skipCache,
        collectLog: options.collectLog,
      },
    } as Parameters<typeof createAiGateway>[0])
    const unified = createUnified({ apiKey })
    return { languageModel: (id) => sdk(unified(id)) }
  }
}
