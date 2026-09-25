import type { LanguageModelV3 } from "@ai-sdk/provider"
import { ProviderSDK } from "../provider-sdk"

export async function sapFactory(): Promise<ProviderSDK.Factory> {
  const { createSAPAIProvider } = await import("@jerome-benoit/sap-ai-provider")
  return (options) => {
    const serviceKey =
      ProviderSDK.string(options, "serviceKey") ??
      ProviderSDK.string(options, "apiKey") ??
      process.env.AICORE_SERVICE_KEY
    const key = !options.destination && serviceKey ? sapServiceKey(serviceKey) : undefined
    if (!options.destination && !key) throw new Error("SAP AI Core requires a service key or an explicit destination")
    const deploymentId = ProviderSDK.string(options, "deploymentId") ?? process.env.AICORE_DEPLOYMENT_ID
    const resourceGroup = ProviderSDK.string(options, "resourceGroup") ?? process.env.AICORE_RESOURCE_GROUP
    const requestConfig = options.requestConfig as Record<string, unknown> | undefined
    if (
      key &&
      requestConfig &&
      ["url", "baseURL", "socketPath", "auth", "adapter", "transport"].some((name) => requestConfig[name] !== undefined)
    )
      throw new Error("SAP AI Core service-key credentials cannot be combined with request URL or transport overrides")
    const settings = {
      ...options,
      deploymentId,
      resourceGroup: deploymentId ? undefined : resourceGroup,
      requestConfig: {
        ...requestConfig,
        ...(key ? { maxRedirects: 0 } : {}),
        headers: {
          ...(requestConfig?.headers as Record<string, string> | undefined),
          ...(resourceGroup ? { "AI-Resource-Group": resourceGroup } : {}),
        },
      },
      logLevel: "error",
    }
    const create = (destination: unknown) =>
      createSAPAIProvider({ ...settings, destination } as Parameters<typeof createSAPAIProvider>[0])
    if (!key) return create(options.destination)
    // Keep authentication scoped to this SDK instance. The SAP SDK's environment
    // discovery caches a single process-wide service binding across accounts.
    const cached: { token?: string; expires: number } = { expires: 0 }
    const request = (options.fetch as typeof fetch | undefined) ?? fetch
    const token = async (signal?: AbortSignal) => {
      signal?.throwIfAborted()
      if (cached.token && cached.expires > Date.now() + 60_000) return cached.token
      const response = await request(key.tokenURL, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${key.clientId}:${key.clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`SAP AI Core token request failed (HTTP ${response.status})`)
      }
      const body = await boundedTokenJSON(response)
      if (
        typeof body.access_token !== "string" ||
        !body.access_token ||
        typeof body.expires_in !== "number" ||
        !Number.isFinite(body.expires_in)
      )
        throw new Error("SAP AI Core returned an invalid token response")
      cached.token = body.access_token
      cached.expires = Date.now() + Math.max(0, body.expires_in) * 1000
      return body.access_token
    }
    return {
      languageModel(id) {
        const prototype = create({ url: key.url, authentication: "NoAuthentication" }).languageModel(id)
        const authorized = async (signal?: AbortSignal) =>
          create({
            url: key.url,
            authentication: "NoAuthentication",
            headers: { Authorization: `Bearer ${await token(signal)}` },
          }).languageModel(id)
        return {
          specificationVersion: prototype.specificationVersion,
          modelId: prototype.modelId,
          provider: prototype.provider,
          supportedUrls: prototype.supportedUrls,
          async doGenerate(call) {
            return (await authorized(call.abortSignal)).doGenerate(call)
          },
          async doStream(call) {
            return (await authorized(call.abortSignal)).doStream(call)
          },
        } satisfies LanguageModelV3
      },
    }
  }
}

export function sapServiceKey(serviceKey: string) {
  const key = ProviderSDK.parseJSON(serviceKey)
  if (!key || typeof key !== "object" || Array.isArray(key))
    throw new Error("SAP AI Core service key must be a JSON object")
  const value = key as Record<string, unknown>
  const urls = value.serviceurls as Record<string, unknown> | undefined
  const url = urls && ProviderSDK.string(urls, "AI_API_URL")
  const issuer = ProviderSDK.string(value, "url")
  const clientId = ProviderSDK.string(value, "clientid")
  const clientSecret = ProviderSDK.string(value, "clientsecret")
  if (!url || !issuer || !clientId || !clientSecret)
    throw new Error("SAP AI Core service key requires serviceurls.AI_API_URL, url, clientid and clientsecret")
  for (const endpoint of [url, issuer]) {
    const parsed = new URL(endpoint)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw new Error(
        "SAP AI Core service key endpoints must use HTTPS without embedded credentials, query or fragment",
      )
  }
  return { url, tokenURL: `${issuer.replace(/\/$/, "")}/oauth/token`, clientId, clientSecret }
}

async function boundedTokenJSON(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("SAP AI Core returned an empty token response")
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > 65_536) throw new Error("SAP AI Core token response exceeded its size limit")
      chunks.push(next.value)
    }
    const value = ProviderSDK.parseJSON(Buffer.concat(chunks).toString())
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("SAP AI Core returned an invalid token response")
    return value as Record<string, unknown>
  } finally {
    await reader.cancel()
  }
}
