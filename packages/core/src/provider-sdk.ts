export * as ProviderSDK from "./provider-sdk"

import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Option, Schema } from "effect"

export const packages = [
  "ai-gateway-provider",
  "@jerome-benoit/sap-ai-provider",
  "@aihubmix/ai-sdk-provider",
  "merge-gateway-ai-sdk-provider",
  "watsonx-ai-provider",
  "@qvac/ai-sdk-provider",
] as const

export type SDK = { languageModel(id: string): LanguageModelV3 }
export type Factory = (options: Record<string, unknown>) => SDK

// Both engines use the same reviewed entrypoints. Never resolve these SDKs through
// the runtime package installer or guess a factory from a package's exports.
export async function load(pkg: string): Promise<Factory> {
  switch (pkg) {
    case "ai-gateway-provider": {
      const { cloudflareFactory } = await import("./provider-sdk/cloudflare")
      return cloudflareFactory()
    }
    case "@jerome-benoit/sap-ai-provider": {
      const { sapFactory } = await import("./provider-sdk/sap")
      return sapFactory()
    }
    case "@aihubmix/ai-sdk-provider": {
      const { createAihubmix } = await import("@aihubmix/ai-sdk-provider")
      return (options) => {
        const request = (options.fetch as typeof fetch | undefined) ?? fetch
        const appCode =
          string(options, "appCode") ?? new Headers(options.headers as HeadersInit | undefined).get("APP-Code")
        return createAihubmix({
          ...options,
          // The SDK otherwise silently supplies its publisher's referral code.
          appCode: appCode ?? "",
          baseURL: string(options, "baseURL")?.replace(/\/v1\/?$/, ""),
          fetch: Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const headers = new Headers(init?.headers)
              if (appCode === undefined || appCode === null) headers.delete("APP-Code")
              return request(input, { ...init, headers })
            },
            { preconnect: request.preconnect },
          ),
        })
      }
    }
    case "merge-gateway-ai-sdk-provider": {
      const { createMergeGateway } = await import("merge-gateway-ai-sdk-provider")
      return (options) => createMergeGateway(options)
    }
    case "watsonx-ai-provider": {
      const { watsonxFactory } = await import("./provider-sdk/watsonx")
      return watsonxFactory()
    }
    case "@qvac/ai-sdk-provider": {
      const { createQvac } = await import("@qvac/ai-sdk-provider")
      return (options) => {
        const baseURL = string(options, "baseURL")
        if (!baseURL) throw new Error("QVAC requires an explicit baseURL for an already running external runtime")
        const url = new URL(baseURL)
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          throw new Error("QVAC baseURL must be an HTTP(S) endpoint without embedded credentials")
        return createQvac({ ...options, baseURL })
      }
    }
    default:
      throw new Error(`No reviewed SDK factory for ${pkg}`)
  }
}

export function string(options: Record<string, unknown>, name: string) {
  return typeof options[name] === "string" && options[name] ? options[name] : undefined
}

const decodeJSON = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
export function parseJSON(value: unknown) {
  const decoded = decodeJSON(value)
  if (Option.isNone(decoded)) throw new Error("Invalid provider JSON configuration")
  return decoded.value
}
