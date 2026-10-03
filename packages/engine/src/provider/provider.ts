import {
  activeOAuthApproval,
  pluginCredentialAllowed,
  requirePluginDestination,
} from "@vectordevai/core/plugin/oauth-approval"
import { ProviderSDK } from "@vectordevai/core/provider-sdk"
import { FreeModels } from "@vectordevai/core/free-models"
import { freeModelRequest, serializeFreeModelRequest } from "@vectordevai/core/free-model-request"
import type { FreeModelInfo } from "@vectordevai/schema/free-model"
import { isFreeModel } from "@vectordevai/schema/free-model"
import { ProviderUnavailable, providerRetired, providerUnavailable } from "@vectordevai/schema/provider-unavailable"
import { renamedModel } from "@vectordevai/schema/provider-policy"
import {
  providerAllowed,
  providerCredentialAllowed,
  providerCredentialUnavailable,
  providerEnabled,
  providerEnvironmentAllowed,
  providerUsable,
  requireGitlabOAuthEndpoint,
} from "@vectordevai/core/provider-policy"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import os from "os"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import fuzzysort from "fuzzysort"
import { Config } from "@/config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Npm } from "@vectordevai/core/npm"
import { Hash } from "@vectordevai/core/util/hash"
import { Plugin } from "../plugin"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import { ModelCatalog } from "@vectordevai/core/model-catalog"
import { OAUTH_DUMMY_KEY } from "@/auth"
import { Auth } from "../auth"
import { Env } from "../env"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { iife } from "@/util/iife"
import { Global } from "@vectordevai/core/global"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema, Types } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { EffectPromise } from "@/effect/promise"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Redaction } from "@vectordevai/core/redaction"
import { isRecord } from "@/util/record"
import { optional } from "@vectordevai/core/schema"
import { ProviderTransform } from "./transform"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ModelV2 } from "@vectordevai/core/model"
import { ModelStatus } from "./model-status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderError } from "./error"

const OPENAI_HEADER_TIMEOUT_DEFAULT = 10_000

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new ProviderError.ResponseStreamError("SSE read timed out")
          ctl.abort(err)
          void reader.cancel(err)
          reject(err)
        }, ms)

        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}

function googleVertexAnthropicBaseURL(project: string | undefined, location: string | undefined) {
  if (!project) return
  if (location !== "eu" && location !== "us") return
  // Continental multi-regions require Regional Endpoint Platform domains.
  return `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models`
}

type BundledSDK = {
  languageModel(modelId: string): LanguageModelV3
  chat?: (modelId: string) => LanguageModelV3
  responses?: (modelId: string) => LanguageModelV3
}

const BUNDLED_PROVIDERS: Record<string, () => Promise<(opts: any) => BundledSDK>> = {
  "ai-gateway-provider": () => ProviderSDK.load("ai-gateway-provider"),
  "@jerome-benoit/sap-ai-provider": () => ProviderSDK.load("@jerome-benoit/sap-ai-provider"),
  "@aihubmix/ai-sdk-provider": () => ProviderSDK.load("@aihubmix/ai-sdk-provider"),
  "merge-gateway-ai-sdk-provider": () => ProviderSDK.load("merge-gateway-ai-sdk-provider"),
  "watsonx-ai-provider": () => ProviderSDK.load("watsonx-ai-provider"),
  "@qvac/ai-sdk-provider": () => ProviderSDK.load("@qvac/ai-sdk-provider"),
  "@ai-sdk/amazon-bedrock": () => import("@ai-sdk/amazon-bedrock").then((m) => m.createAmazonBedrock),
  "@ai-sdk/amazon-bedrock/mantle": () => import("@ai-sdk/amazon-bedrock/mantle").then((m) => m.createBedrockMantle),
  "@ai-sdk/anthropic": () => import("@ai-sdk/anthropic").then((m) => m.createAnthropic),
  "@ai-sdk/azure": () => import("@ai-sdk/azure").then((m) => m.createAzure),
  "@ai-sdk/google": () => import("@ai-sdk/google").then((m) => m.createGoogleGenerativeAI),
  "@ai-sdk/google-vertex": () => import("@ai-sdk/google-vertex").then((m) => m.createVertex),
  "@ai-sdk/google-vertex/anthropic": () =>
    import("@ai-sdk/google-vertex/anthropic").then((m) => m.createVertexAnthropic),
  "@ai-sdk/openai": () => import("@ai-sdk/openai").then((m) => m.createOpenAI),
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible),
  "@openrouter/ai-sdk-provider": () => import("@openrouter/ai-sdk-provider").then((m) => m.createOpenRouter),
  "@ai-sdk/xai": () => import("@ai-sdk/xai").then((m) => m.createXai),
  "@ai-sdk/mistral": () => import("@ai-sdk/mistral").then((m) => m.createMistral),
  "@ai-sdk/groq": () => import("@ai-sdk/groq").then((m) => m.createGroq),
  "@ai-sdk/deepinfra": () => import("@ai-sdk/deepinfra").then((m) => m.createDeepInfra),
  "@ai-sdk/cerebras": () => import("@ai-sdk/cerebras").then((m) => m.createCerebras),
  "@ai-sdk/cohere": () => import("@ai-sdk/cohere").then((m) => m.createCohere),
  "@ai-sdk/gateway": () => import("@ai-sdk/gateway").then((m) => m.createGateway),
  "@ai-sdk/togetherai": () => import("@ai-sdk/togetherai").then((m) => m.createTogetherAI),
  "@ai-sdk/perplexity": () => import("@ai-sdk/perplexity").then((m) => m.createPerplexity),
  "@ai-sdk/vercel": () => import("@ai-sdk/vercel").then((m) => m.createVercel),
  "@ai-sdk/alibaba": () => import("@ai-sdk/alibaba").then((m) => m.createAlibaba),
  "gitlab-ai-provider": () => import("gitlab-ai-provider").then((m) => m.createGitLab),
  "@ai-sdk/github-copilot": () =>
    import("@vectordevai/core/github-copilot/copilot-provider").then((m) => m.createOpenaiCompatible),
  "venice-ai-sdk-provider": () => import("venice-ai-sdk-provider").then((m) => m.createVenice),
}

type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>, model?: Model) => Promise<any>
type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
type CustomDiscoverModels = () => Promise<Record<string, Model>>
type CustomLoader = (provider: Info) => Effect.Effect<{
  autoload: boolean
  getModel?: CustomModelLoader
  vars?: CustomVarsLoader
  options?: Record<string, any>
  discoverModels?: CustomDiscoverModels
}>

type CustomDep = {
  auth: (id: string) => Effect.Effect<Auth.Info | undefined>
  config: () => Effect.Effect<ConfigV1.Info>
  env: () => Effect.Effect<Record<string, string | undefined>>
  get: (key: string) => Effect.Effect<string | undefined>
}

function selectAzureLanguageModel(sdk: any, modelID: string, useChat: boolean) {
  if (useChat && sdk.chat) return sdk.chat(modelID)
  if (sdk.responses) return sdk.responses(modelID)
  if (sdk.messages) return sdk.messages(modelID)
  if (sdk.chat) return sdk.chat(modelID)
  return sdk.languageModel(modelID)
}

function selectBedrockMantleLanguageModel(sdk: BundledSDK, modelID: string) {
  if (modelID === "openai.gpt-oss-safeguard-20b" || modelID === "openai.gpt-oss-safeguard-120b")
    return sdk.chat?.(modelID) ?? sdk.languageModel(modelID)
  return sdk.responses?.(modelID) ?? sdk.languageModel(modelID)
}

function custom(dep: CustomDep): Record<string, CustomLoader> {
  return {
    anthropic: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
          },
        },
      }),
    openai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: { headerTimeout: OPENAI_HEADER_TIMEOUT_DEFAULT },
      }),
    xai: () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>) {
          return sdk.responses(modelID)
        },
        options: {},
      }),
    "github-copilot": () =>
      Effect.succeed({
        autoload: false,
        async getModel(sdk: any, modelID: string, _options?: Record<string, any>, model?: Model) {
          if (sdk.responses === undefined && sdk.chat === undefined) return sdk.languageModel(modelID)
          if (model && "endpoint" in model.api) {
            if (model.api.endpoint === "responses" && sdk.responses) return sdk.responses(modelID)
            if (model.api.endpoint === "chat" && sdk.chat) return sdk.chat(modelID)
          }
          const match = /^gpt-(\d+)/.exec(modelID)
          if (match && Number(match[1]) >= 5 && !modelID.startsWith("gpt-5-mini")) return sdk.responses(modelID)
          return sdk.chat(modelID)
        },
        options: {},
      }),
    azure: Effect.fnUntraced(function* (provider: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(provider.id)
      const resource = iife(() => {
        return [
          provider.options?.resourceName,
          auth?.type === "api" ? auth.metadata?.resourceName : undefined,
          env["AZURE_RESOURCE_NAME"],
        ].find((name) => typeof name === "string" && name.trim() !== "")
      })

      if (!resource && !provider.options?.baseURL) {
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "AZURE_RESOURCE_NAME is missing, set it using env var or reconnecting the azure provider and setting it",
            )
          },
        }
      }

      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          resourceName: resource,
        },
        vars(_options): Record<string, string> {
          if (resource) {
            return {
              AZURE_RESOURCE_NAME: resource,
            }
          }
          return {}
        },
      }
    }),
    "azure-cognitive-services": Effect.fnUntraced(function* () {
      const resourceName = yield* dep.get("AZURE_COGNITIVE_SERVICES_RESOURCE_NAME")
      return {
        autoload: false,
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          return selectAzureLanguageModel(sdk, modelID, Boolean(options?.["useCompletionUrls"]))
        },
        options: {
          baseURL: resourceName ? `https://${resourceName}.cognitiveservices.azure.com/openai` : undefined,
        },
      }
    }),
    "amazon-bedrock": Effect.fnUntraced(function* () {
      const providerConfig = (yield* dep.config()).provider?.["amazon-bedrock"]
      const auth = yield* dep.auth("amazon-bedrock")
      const env = yield* dep.env()

      // Region precedence: 1) config file, 2) env var, 3) default
      const configRegion = providerConfig?.options?.region
      const envRegion = env["AWS_REGION"]
      const defaultRegion = configRegion ?? envRegion ?? "us-east-1"

      // Profile: config file takes precedence over env var
      const configProfile = providerConfig?.options?.profile
      const envProfile = env["AWS_PROFILE"]
      const profile = configProfile ?? envProfile

      const awsAccessKeyId = env["AWS_ACCESS_KEY_ID"]
      const configApiKey = providerConfig?.options?.apiKey

      // TODO: Using process.env directly because Env.set only updates a process.env shallow copy,
      // until the scope of the Env API is clarified (test only or runtime?)
      const awsBearerToken = iife(() => {
        const envToken = process.env.AWS_BEARER_TOKEN_BEDROCK
        if (envToken) return envToken
        if (auth?.type === "api") {
          process.env.AWS_BEARER_TOKEN_BEDROCK = auth.key
          return auth.key
        }
        return undefined
      })

      const awsWebIdentityTokenFile = env["AWS_WEB_IDENTITY_TOKEN_FILE"]

      const containerCreds = Boolean(
        process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
      )

      if (
        !profile &&
        !awsAccessKeyId &&
        !awsBearerToken &&
        !configApiKey &&
        !awsWebIdentityTokenFile &&
        !containerCreds
      )
        return { autoload: false }

      const { fromNodeProviderChain } = yield* Effect.promise(() => import("@aws-sdk/credential-providers"))

      const providerOptions: Record<string, any> = {
        region: defaultRegion,
      }

      // Only use credential chain if no bearer token exists
      // Bearer token takes precedence over credential chain (profiles, access keys, IAM roles, web identity tokens)
      if (!awsBearerToken && !configApiKey) {
        // Build credential provider options (only pass profile if specified)
        const credentialProviderOptions = profile ? { profile } : {}

        providerOptions.credentialProvider = fromNodeProviderChain(credentialProviderOptions)
      }

      // Add custom endpoint if specified (endpoint takes precedence over baseURL)
      const endpoint = providerConfig?.options?.endpoint ?? providerConfig?.options?.baseURL
      if (endpoint) {
        providerOptions.baseURL = endpoint
      }

      return {
        autoload: true,
        options: providerOptions,
        vars(options: Record<string, any>) {
          return { AWS_REGION: options.region ?? defaultRegion }
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>, model?: Model) {
          if (model?.api.npm === "@ai-sdk/amazon-bedrock/mantle") return selectBedrockMantleLanguageModel(sdk, modelID)

          // Skip region prefixing if model already has a cross-region inference profile prefix
          // Catalog models may already include prefixes like us., eu., global., etc.
          const crossRegionPrefixes = ["global.", "us.", "eu.", "jp.", "apac.", "au."]
          if (crossRegionPrefixes.some((prefix) => modelID.startsWith(prefix))) {
            return sdk.languageModel(modelID)
          }

          // Region resolution precedence (highest to lowest):
          // 1. options.region from vector.json provider config
          // 2. defaultRegion from AWS_REGION environment variable
          // 3. Default "us-east-1" (baked into defaultRegion)
          const region = options?.region ?? defaultRegion

          let regionPrefix = region.split("-")[0]

          switch (regionPrefix) {
            case "us": {
              const modelRequiresPrefix = [
                "nova-micro",
                "nova-lite",
                "nova-pro",
                "nova-premier",
                "nova-2",
                "claude",
                "deepseek",
              ].some((m) => modelID.includes(m))
              const isGovCloud = region.startsWith("us-gov")
              if (modelRequiresPrefix && !isGovCloud) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "eu": {
              const regionRequiresPrefix = [
                "eu-west-1",
                "eu-west-2",
                "eu-west-3",
                "eu-north-1",
                "eu-central-1",
                "eu-south-1",
                "eu-south-2",
              ].some((r) => region.includes(r))
              const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "llama3", "pixtral"].some((m) =>
                modelID.includes(m),
              )
              if (regionRequiresPrefix && modelRequiresPrefix) {
                modelID = `${regionPrefix}.${modelID}`
              }
              break
            }
            case "ap": {
              const isAustraliaRegion = ["ap-southeast-2", "ap-southeast-4"].includes(region)
              const isTokyoRegion = region === "ap-northeast-1"
              if (
                isAustraliaRegion &&
                ["anthropic.claude-sonnet-4-5", "anthropic.claude-haiku"].some((m) => modelID.includes(m))
              ) {
                regionPrefix = "au"
                modelID = `${regionPrefix}.${modelID}`
              } else if (isTokyoRegion) {
                // Tokyo region uses jp. prefix for cross-region inference
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "jp"
                  modelID = `${regionPrefix}.${modelID}`
                }
              } else {
                // Other APAC regions use apac. prefix
                const modelRequiresPrefix = ["claude", "nova-lite", "nova-micro", "nova-pro"].some((m) =>
                  modelID.includes(m),
                )
                if (modelRequiresPrefix) {
                  regionPrefix = "apac"
                  modelID = `${regionPrefix}.${modelID}`
                }
              }
              break
            }
          }

          return sdk.languageModel(modelID)
        },
      }
    }),
    llmgateway: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-Title": "Vector",
            "X-Source": "vector",
          },
        },
      }),
    openrouter: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-OpenRouter-Title": "Vector",
          },
        },
      }),
    nvidia: (provider) =>
      Effect.succeed({
        autoload: provider.source === "config",
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-Title": "Vector",
            "X-BILLING-INVOKE-ORIGIN": "Vector",
          },
        },
      }),
    vercel: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "http-referer": "https://vectordev.ai/",
            "x-title": "Vector",
          },
        },
      }),
    "google-vertex": Effect.fnUntraced(function* (provider: Info) {
      const env = yield* dep.env()
      // The catalog advertises GOOGLE_VERTEX_PROJECT for Vertex; keep the wider
      // Google Cloud project env names as fallbacks for existing ADC setups.
      const project =
        provider.options?.project ??
        env["GOOGLE_VERTEX_PROJECT"] ??
        env["GOOGLE_CLOUD_PROJECT"] ??
        env["GCP_PROJECT"] ??
        env["GCLOUD_PROJECT"]

      const location = String(
        provider.options?.location ??
          env["GOOGLE_VERTEX_LOCATION"] ??
          env["GOOGLE_CLOUD_LOCATION"] ??
          env["VERTEX_LOCATION"] ??
          "us-central1",
      )

      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      return {
        autoload: true,
        vars(_options: Record<string, any>) {
          const endpoint = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`
          return {
            ...(project && { GOOGLE_VERTEX_PROJECT: project }),
            GOOGLE_VERTEX_LOCATION: location,
            GOOGLE_VERTEX_ENDPOINT: endpoint,
          }
        },
        options: {
          project,
          location,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const { GoogleAuth } = await import("google-auth-library")
            const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
            const client = await auth.getClient()
            const token = await client.getAccessToken()

            const headers = new Headers(init?.headers)
            headers.set("Authorization", `Bearer ${token.token}`)

            return fetch(input, { ...init, headers })
          },
        },
        async getModel(sdk: any, modelID: string) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "google-vertex-anthropic": Effect.fnUntraced(function* () {
      const env = yield* dep.env()
      const project = env["GOOGLE_CLOUD_PROJECT"] ?? env["GCP_PROJECT"] ?? env["GCLOUD_PROJECT"]
      const location = env["GOOGLE_CLOUD_LOCATION"] ?? env["VERTEX_LOCATION"] ?? "global"
      const autoload = Boolean(project)
      if (!autoload) return { autoload: false }
      const baseURL = googleVertexAnthropicBaseURL(project, location)
      return {
        autoload: true,
        options: {
          project,
          location,
          ...(baseURL && { baseURL }),
        },
        async getModel(sdk: any, modelID) {
          const id = String(modelID).trim()
          return sdk.languageModel(id)
        },
      }
    }),
    "sap-ai-core": Effect.fnUntraced(function* () {
      const auth = yield* dep.auth("sap-ai-core")
      const env = yield* dep.env()
      const serviceKey = env.AICORE_SERVICE_KEY ?? (auth?.type === "api" ? auth.key : undefined)
      return {
        autoload: !!serviceKey,
        options: { serviceKey, deploymentId: env.AICORE_DEPLOYMENT_ID, resourceGroup: env.AICORE_RESOURCE_GROUP },
      }
    }),
    zenmux: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-Title": "Vector",
          },
        },
      }),
    gitlab: Effect.fnUntraced(function* (input: Info) {
      const {
        VERSION: GITLAB_PROVIDER_VERSION,
        isWorkflowModel,
        discoverWorkflowModels,
      } = yield* Effect.promise(() => import("gitlab-ai-provider"))

      const instanceUrl = (yield* dep.get("GITLAB_INSTANCE_URL")) || "https://gitlab.com"

      const auth = yield* dep.auth(input.id)
      const apiKey = auth?.type === "oauth" ? auth.access : auth?.type === "api" ? auth.key : undefined
      const token = apiKey ?? (yield* dep.get("GITLAB_TOKEN"))

      const providerConfig = (yield* dep.config()).provider?.["gitlab"]
      const directory = yield* InstanceState.directory

      const aiGatewayHeaders = {
        "User-Agent": `vector/${InstallationVersion} gitlab-ai-provider/${GITLAB_PROVIDER_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`,
        "anthropic-beta": "context-1m-2025-08-07",
        ...providerConfig?.options?.aiGatewayHeaders,
      }

      const featureFlags = {
        duo_agent_platform_agentic_chat: true,
        duo_agent_platform: true,
        ...providerConfig?.options?.featureFlags,
      }

      return {
        autoload: !!token,
        options: {
          instanceUrl,
          apiKey: token,
          aiGatewayHeaders,
          featureFlags,
        },
        async getModel(sdk: any, modelID: string, options?: Record<string, any>) {
          if (modelID.startsWith("duo-workflow-")) {
            const workflowRef = typeof options?.workflowRef === "string" ? options.workflowRef : undefined
            // Use the static mapping if it exists, otherwise use duo-workflow with selectedModelRef
            const sdkModelID = isWorkflowModel(modelID) ? modelID : "duo-workflow"
            const workflowDefinition =
              typeof options?.workflowDefinition === "string" ? options.workflowDefinition : undefined
            const model = sdk.workflowChat(sdkModelID, {
              featureFlags,
              workflowDefinition,
            })
            if (workflowRef) {
              model.selectedModelRef = workflowRef
            }
            return model
          }
          return sdk.agenticChat(modelID, {
            aiGatewayHeaders,
            featureFlags,
          })
        },
        async discoverModels(): Promise<Record<string, Model>> {
          if (!apiKey) {
            return {}
          }

          try {
            const token = apiKey
            const getHeaders = (): Record<string, string> =>
              auth?.type === "api" ? { "PRIVATE-TOKEN": token } : { Authorization: `Bearer ${token}` }

            const result = await discoverWorkflowModels({ instanceUrl, getHeaders }, { workingDirectory: directory })

            if (!result.models.length) {
              return {}
            }

            const models: Record<string, Model> = {}
            for (const m of result.models) {
              if (!input.models[m.id]) {
                models[m.id] = {
                  id: ModelV2.ID.make(m.id),
                  providerID: ProviderV2.ID.make("gitlab"),
                  name: `Agent Platform (${m.name})`,
                  family: "",
                  api: {
                    id: m.id,
                    url: instanceUrl,
                    npm: "gitlab-ai-provider",
                  },
                  status: "active",
                  headers: {},
                  options: { workflowRef: m.ref },
                  cost: { ...UNPRICED },
                  limit: { context: m.context, output: m.output },
                  capabilities: {
                    temperature: false,
                    reasoning: true,
                    attachment: true,
                    toolcall: true,
                    input: {
                      text: true,
                      audio: false,
                      image: true,
                      video: false,
                      pdf: true,
                    },
                    output: {
                      text: true,
                      audio: false,
                      image: false,
                      video: false,
                      pdf: false,
                    },
                    interleaved: false,
                  },
                  release_date: "",
                  variants: {},
                }
              }
            }

            return models
          } catch (e) {
            return {}
          }
        },
      }
    }),
    "cloudflare-workers-ai": Effect.fnUntraced(function* (input: Info) {
      // When baseURL is already configured (e.g. corporate config routing through a proxy/gateway),
      // skip the account ID check because the URL is already fully specified.
      if (input.options?.baseURL) return { autoload: false }

      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId = env["CLOUDFLARE_ACCOUNT_ID"] || (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      if (!accountId)
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              "CLOUDFLARE_ACCOUNT_ID is missing. Set it with: export CLOUDFLARE_ACCOUNT_ID=<your-account-id>",
            )
          },
        }

      const apiKey = env["CLOUDFLARE_API_KEY"] || (auth?.type === "api" ? auth.key : undefined)

      return {
        autoload: !!apiKey,
        options: {
          apiKey,
          headers: {
            "User-Agent": `vector/${InstallationVersion} cloudflare-workers-ai (${os.platform()} ${os.release()}; ${os.arch()})`,
          },
        },
        async getModel(sdk: any, modelID: string) {
          return sdk.languageModel(modelID)
        },
        vars(_options) {
          return {
            CLOUDFLARE_ACCOUNT_ID: accountId,
          }
        },
      }
    }),
    "cloudflare-ai-gateway": Effect.fnUntraced(function* (input: Info) {
      const auth = yield* dep.auth(input.id)
      const env = yield* dep.env()
      const accountId =
        input.options?.accountId ??
        env.CLOUDFLARE_ACCOUNT_ID ??
        (auth?.type === "api" ? auth.metadata?.accountId : undefined)
      const gatewayId =
        input.options?.gatewayId ??
        input.options?.gateway ??
        env.CLOUDFLARE_GATEWAY_ID ??
        (auth?.type === "api" ? auth.metadata?.gatewayId : undefined)
      const apiKey =
        input.options?.apiKey ??
        env.CLOUDFLARE_API_TOKEN ??
        env.CF_AIG_TOKEN ??
        (auth?.type === "api" ? auth.key : undefined)
      return { autoload: !!(accountId && gatewayId && apiKey), options: { accountId, gatewayId, apiKey } }
    }),
    cerebras: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "X-Cerebras-3rd-Party-Integration": "vector",
          },
        },
      }),
    kilo: () =>
      Effect.succeed({
        autoload: false,
        options: {
          headers: {
            "HTTP-Referer": "https://vectordev.ai/",
            "X-Title": "Vector",
          },
        },
      }),
    "snowflake-cortex": Effect.fnUntraced(function* (input: Info) {
      const env = yield* dep.env()
      const auth = yield* dep.auth(input.id)

      const account =
        env["SNOWFLAKE_ACCOUNT"] ??
        (auth?.type === "api" ? auth.metadata?.account : undefined) ??
        (auth?.type === "oauth" ? auth.accountId : undefined) ??
        input.options?.account

      const envToken = env["SNOWFLAKE_CORTEX_TOKEN"] ?? env["SNOWFLAKE_CORTEX_PAT"]
      const apiKeyToken = auth?.type === "api" ? auth.key : undefined
      const oauthToken = auth?.type === "oauth" ? auth.access : undefined
      const configToken = input.options?.token ?? input.options?.apiKey

      const token = envToken ?? apiKeyToken ?? oauthToken ?? configToken

      if (!account || !token) {
        const missing = [!account && "SNOWFLAKE_ACCOUNT", !token && "SNOWFLAKE_CORTEX_TOKEN"].filter(Boolean).join(", ")
        return {
          autoload: false,
          async getModel() {
            throw new Error(
              `Snowflake Cortex: missing credentials (${missing}). Provide a bearer token (OAuth, JWT, or PAT) via env var, vector auth, or provider options.`,
            )
          },
        }
      }

      const baseURL = `https://${account}.snowflakecomputing.com/api/v2/cortex/v1`

      const options: Record<string, any> = { baseURL, apiKey: token }

      // Only skip provider-level fetch when the token is from OAuth with no override.
      // For OAuth tokens, the plugin auth loader's combined fetch handles
      // OAuth refresh + snowflake transformations in one place.
      // For env/config/API-key tokens, the provider fetch applies snowflake
      // transformations directly.
      const useOAuthHandler =
        oauthToken !== undefined && envToken === undefined && apiKeyToken === undefined && configToken === undefined
      if (!useOAuthHandler) {
        options.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
          if (init?.body && typeof init.body === "string") {
            try {
              const body = JSON.parse(init.body)
              if ("max_tokens" in body) {
                body.max_completion_tokens = body.max_tokens
                delete body.max_tokens
                init = { ...init, body: JSON.stringify(body) }
              }
            } catch {}
          }

          const response = await fetch(url, init)

          if (!response.ok && response.status === 400) {
            try {
              const errorData = await response.clone().json()
              const errorMessage = String(errorData.message || errorData.error || "")
              if (errorMessage.toLowerCase().includes("conversation complete")) {
                return new Response(
                  JSON.stringify({
                    choices: [{ finish_reason: "stop", message: { content: "", role: "assistant" } }],
                  }),
                  { status: 200, headers: new Headers({ "content-type": "application/json" }) },
                )
              }
            } catch {}
          }

          if (response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
            const reader = response.body.getReader()
            const encoder = new TextEncoder()
            const decoder = new TextDecoder()
            const stream = new ReadableStream({
              async pull(ctrl) {
                const { done, value } = await reader.read()
                if (done) {
                  ctrl.close()
                  return
                }
                const text = decoder.decode(value, { stream: true })
                ctrl.enqueue(encoder.encode(text.replace(/"role"\s*:\s*""/g, '"role":"assistant"')))
              },
              cancel() {
                reader.cancel()
              },
            })
            return new Response(stream, { headers: response.headers, status: response.status })
          }

          return response
        }
      }

      return {
        autoload: input.source === "config",
        options,
      }
    }),
  }
}

const ProviderApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
})

const ProviderModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const ProviderInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
  }),
])

const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: ProviderModalities,
  output: ProviderModalities,
  interleaved: ProviderInterleaved,
})

const ProviderCacheCost = Schema.Struct({
  read: Schema.Finite,
  write: Schema.Finite,
})

const ProviderCostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const ProviderCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tiers: optional(Schema.Array(ProviderCostTier)),
  experimentalOver200K: optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache: ProviderCacheCost,
    }),
  ),
  // No price is listed for the model: the zero rates mean unknown, not free, and its steps are recorded as unpriced.
  unpriced: optional(Schema.Boolean),
})

const ProviderLimit = Schema.Struct({
  context: Schema.Finite,
  input: optional(Schema.Finite),
  output: Schema.Finite,
})

export const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  api: ProviderApiInfo,
  name: Schema.String,
  freeModel: optional(Schema.Struct({ source: Schema.Literals(["shared", "openrouter"]) })),
  family: optional(Schema.String),
  capabilities: ProviderCapabilities,
  cost: ProviderCost,
  limit: ProviderLimit,
  status: ModelStatus,
  options: Schema.Record(Schema.String, Schema.Any),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  variants: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
}).annotate({ identifier: "Model" })
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export const Info = Schema.Struct({
  id: ProviderV2.ID,
  name: Schema.String,
  source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String),
  key: optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any),
  models: Schema.Record(Schema.String, Model),
}).annotate({ identifier: "Provider" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

const DefaultModelIDs = Schema.Record(Schema.String, Schema.String)

export const ListResult = Schema.Struct({
  all: Schema.Array(Info),
  default: DefaultModelIDs,
  connected: Schema.Array(Schema.String),
  unavailable: Schema.optional(Schema.Array(ProviderUnavailable)),
})
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

export const ConfigProvidersResult = Schema.Struct({
  providers: Schema.Array(Info),
  default: DefaultModelIDs,
})
export type ConfigProvidersResult = Types.DeepMutable<Schema.Schema.Type<typeof ConfigProvidersResult>>

export function toPublicInfo(provider: Info): Info {
  return JSON.parse(
    JSON.stringify(provider, (_, value) => {
      if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined
      if (typeof value === "bigint") return value.toString()
      return value
    }),
  )
}

// These sign-in placeholders contain no credentials. All other key values stay private.
const CLIENT_VISIBLE_API_KEYS = new Set<string>(["", OAUTH_DUMMY_KEY])

/**
 * The provider record as a client may see it. The provider list and config
 * endpoints used to send toPublicInfo(), which still carries `key`, the user's
 * stored API key, to every client of the server, including guests invited with
 * `vector invite`. Clients need to know how a provider is connected, never the
 * credential itself. Model options, headers and variants can carry keys too.
 */
export function toClientInfo(provider: Info): Info {
  const { key: _key, ...info } = toPublicInfo(provider)
  const apiKey = info.options?.apiKey
  const options = Redaction.omit(info.options ?? {})
  if (typeof apiKey === "string" && CLIENT_VISIBLE_API_KEYS.has(apiKey)) options.apiKey = apiKey
  const models = mapValues(info.models ?? {}, (model) => ({
    ...model,
    options: Redaction.omit(model.options ?? {}),
    headers: Redaction.omit(model.headers ?? {}),
    variants: Redaction.omit(model.variants),
  }))
  return { ...info, options, models }
}

export function defaultModelIDs<
  T extends { models: Record<string, { id: string; freeModel?: { source: "shared" | "openrouter" } }> },
>(providers: Record<string, T>) {
  return Object.fromEntries(
    Object.entries(providers).flatMap(([id, item]) => {
      const model = sort(
        Object.values(item.models).filter((model) => id !== "openrouter" || model.freeModel?.source === "openrouter"),
      )[0]
      return model ? [[id, model.id]] : []
    }),
  )
}

export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()("ProviderModelNotFoundError", {
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  suggestions: Schema.optional(Schema.Array(Schema.String)),
  unavailable: Schema.optional(ProviderUnavailable),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    if (this.unavailable) return `Model unavailable: ${this.providerID}/${this.modelID}. ${this.unavailable.message}`
    const suggestions = this.suggestions?.length ? ` Did you mean: ${this.suggestions.join(", ")}?` : ""
    return `Model not found: ${this.providerID}/${this.modelID}.${suggestions}`
  }

  static isInstance(input: unknown): input is ModelNotFoundError {
    return input instanceof ModelNotFoundError
  }
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("ProviderInitError", {
  providerID: ProviderV2.ID,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Failed to initialize provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is InitError {
    return input instanceof InitError
  }
}

export class NoProvidersError extends Schema.TaggedErrorClass<NoProvidersError>()("ProviderNoProvidersError", {}) {
  override get message() {
    return "No providers are available"
  }

  static isInstance(input: unknown): input is NoProvidersError {
    return input instanceof NoProvidersError
  }
}

export class NoModelsError extends Schema.TaggedErrorClass<NoModelsError>()("ProviderNoModelsError", {
  providerID: ProviderV2.ID,
}) {
  override get message() {
    return `No models are available for provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is NoModelsError {
    return input instanceof NoModelsError
  }
}

export type DefaultModelError = ModelNotFoundError | NoProvidersError | NoModelsError
export type Error = ModelNotFoundError | InitError | NoProvidersError | NoModelsError

export interface Interface {
  readonly list: () => Effect.Effect<Record<ProviderV2.ID, Info>>
  readonly unavailable: () => Effect.Effect<ProviderUnavailable[]>
  readonly getProvider: (providerID: ProviderV2.ID) => Effect.Effect<Info>
  readonly getModel: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<Model, ModelNotFoundError>
  readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV3, ModelNotFoundError>
  readonly closest: (
    providerID: ProviderV2.ID,
    query: string[],
  ) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: string } | undefined>
  readonly getSmallModel: (providerID: ProviderV2.ID, primaryID?: ModelV2.ID) => Effect.Effect<Model | undefined>
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }, DefaultModelError>
  /** The model a saved choice names today: renamed providers map to their new ID, retired ones give undefined. */
  readonly savedModel: (model: {
    providerID: string
    modelID: string
  }) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID } | undefined>
}

interface State {
  models: Map<string, LanguageModelV3>
  providers: Record<ProviderV2.ID, Info>
  unavailable: ProviderUnavailable[]
  // Every provider ID configuration or a plugin names, whether or not it loaded.
  declared: Set<string>
  catalog: Record<ProviderV2.ID, Info>
  sdk: Map<string, BundledSDK>
  modelLoaders: Record<string, CustomModelLoader>
  varsLoaders: Record<string, CustomVarsLoader>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Provider") {}

export const use = serviceUse(Service)

// The cost of a model whose provider lists no price.
const UNPRICED: Model["cost"] = { input: 0, output: 0, cache: { read: 0, write: 0 }, unpriced: true }

// A mode that lists its own price replaces the base rates, and is priced even when its base model lists none. When
// it lists no long-context tiers of its own, the base model's follow at the mode's markup: priority pricing is a
// multiple of the standard rates, and the base tiers alone would price a long fast step below a short one.
function modeCost(base: Model["cost"], mode: Model["cost"]): Model["cost"] {
  if (base.unpriced) return mode
  const scale = (rate: number, from: number, to: number) => (from > 0 ? (rate * to) / from : rate)
  const scaled = <T extends Pick<Model["cost"], "input" | "output" | "cache">>(item: T): T => ({
    ...item,
    input: scale(item.input, base.input, mode.input),
    output: scale(item.output, base.output, mode.output),
    cache: {
      read: scale(item.cache.read, base.cache.read, mode.cache.read),
      write: scale(item.cache.write, base.cache.write, mode.cache.write),
    },
  })
  const tiers = mode.tiers ?? base.tiers?.map(scaled)
  const over200K = mode.experimentalOver200K ?? (base.experimentalOver200K && scaled(base.experimentalOver200K))
  return { ...mode, ...(tiers ? { tiers } : {}), ...(over200K ? { experimentalOver200K: over200K } : {}) }
}

function cost(c: ModelCatalog.Model["cost"]): Model["cost"] {
  if (!c) return { ...UNPRICED }
  const result: Model["cost"] = {
    input: c?.input ?? 0,
    output: c?.output ?? 0,
    cache: {
      read: c?.cache_read ?? 0,
      write: c?.cache_write ?? 0,
    },
  }
  if (c?.tiers) {
    result.tiers = c.tiers.map((item) => ({
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read ?? 0,
        write: item.cache_write ?? 0,
      },
      tier: item.tier,
    }))
  }
  if (c?.context_over_200k) {
    result.experimentalOver200K = {
      cache: {
        read: c.context_over_200k.cache_read ?? 0,
        write: c.context_over_200k.cache_write ?? 0,
      },
      input: c.context_over_200k.input,
      output: c.context_over_200k.output,
    }
  }
  return result
}

function fromModelCatalogModel(provider: ModelCatalog.Provider, model: ModelCatalog.Model): Model {
  const base: Model = {
    id: ModelV2.ID.make(model.id),
    providerID: ProviderV2.ID.make(provider.id),
    name: model.name,
    family: model.family,
    api: {
      id: model.id,
      url: model.provider?.api ?? provider.api ?? "",
      npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
    },
    status: model.status ?? "active",
    headers: {},
    options: {},
    cost: cost(model.cost),
    limit: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    capabilities: {
      temperature: model.temperature ?? false,
      reasoning: model.reasoning ?? false,
      attachment: model.attachment ?? false,
      toolcall: model.tool_call ?? true,
      input: {
        text: model.modalities?.input?.includes("text") ?? false,
        audio: model.modalities?.input?.includes("audio") ?? false,
        image: model.modalities?.input?.includes("image") ?? false,
        video: model.modalities?.input?.includes("video") ?? false,
        pdf: model.modalities?.input?.includes("pdf") ?? false,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? false,
        audio: model.modalities?.output?.includes("audio") ?? false,
        image: model.modalities?.output?.includes("image") ?? false,
        video: model.modalities?.output?.includes("video") ?? false,
        pdf: model.modalities?.output?.includes("pdf") ?? false,
      },
      interleaved: model.interleaved ?? false,
    },
    release_date: model.release_date ?? "",
    variants: {},
  }

  return {
    ...base,
    variants: mapValues(ProviderTransform.variants(base), (v) => v),
  }
}

export function fromModelCatalogProvider(provider: ModelCatalog.Provider): Info {
  const models: Record<string, Model> = {}
  for (const [key, model] of Object.entries(provider.models)) {
    models[key] = fromModelCatalogModel(provider, model)
    for (const [mode, opts] of Object.entries(model.experimental?.modes ?? {})) {
      if (!ModelCatalog.modeSupported(model.provider?.npm ?? provider.npm, model.id, opts.provider?.body)) continue
      const id = `${model.id}-${mode}`
      const base = fromModelCatalogModel(provider, model)
      models[id] = {
        ...base,
        id: ModelV2.ID.make(id),
        name: `${model.name} ${mode[0].toUpperCase()}${mode.slice(1)}`,
        cost: opts.cost ? modeCost(base.cost, cost(opts.cost)) : base.cost,
        options: opts.provider?.body
          ? Object.fromEntries(
              Object.entries(opts.provider.body).map(([k, v]) => [
                k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
                v,
              ]),
            )
          : base.options,
        headers: opts.provider?.headers ?? base.headers,
      }
    }
  }
  return {
    id: ProviderV2.ID.make(provider.id),
    source: "custom",
    name: provider.name,
    env: [...(provider.env ?? [])],
    options: {},
    models,
  }
}

export function fromFreeModels(models: readonly FreeModelInfo[], providerID: "vector" | "openrouter" = "vector"): Info {
  return {
    id: ProviderV2.ID.make(providerID),
    name: providerID === "vector" ? "Vector" : "OpenRouter",
    source: "custom",
    env: [providerID === "vector" ? "VECTOR_CLI_TOKEN" : "OPENROUTER_API_KEY"],
    options: {},
    models: Object.fromEntries(
      models.map((model) => [
        model.id,
        {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(providerID),
          name: model.name,
          freeModel: { source: providerID === "vector" ? "shared" : "openrouter" },
          api: {
            id: model.id,
            npm: "@ai-sdk/openai-compatible",
            url: providerID === "vector" ? "https://vectordev.ai/api/free-models" : FreeModels.OPENROUTER_ROOT,
          },
          status: "active",
          headers: {},
          options: {},
          release_date: "",
          variants: {},
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: model.contextLength, output: model.maxOutputTokens },
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
        },
      ]),
    ),
  }
}

function modelSuggestions(provider: Info | undefined, modelID: ModelV2.ID) {
  const available = provider
    ? Object.keys(provider.models).filter((id) => provider.models[id].status !== "deprecated")
    : []
  const fuzzy = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 }).map((m) => m.target)
  if (fuzzy.length) return fuzzy
  const query = modelID
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1)
  return sortBy(
    available
      .map((id) => ({
        id,
        score: query.filter((part) => id.toLowerCase().includes(part)).length,
      }))
      .filter((item) => item.score > 0),
    [(item) => item.score, "desc"],
    [(item) => item.id, "asc"],
  )
    .slice(0, 3)
    .map((item) => item.id)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const env = yield* Env.Service
    const plugin = yield* Plugin.Service
    const modelCatalogSvc = yield* ModelCatalog.Service
    const runtimeFlags = yield* RuntimeFlags.Service
    const freeModels = yield* FreeModels.Service
    const freeCredentials = yield* FreeModels.CredentialsService
    const runtimeBridge = yield* EffectBridge.make()

    const state = yield* InstanceState.make<State>(() =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const cfg = yield* config.get()
        const modelCatalog = Object.fromEntries(
          Object.entries(yield* modelCatalogSvc.get()).filter(([id]) => providerAllowed(id)),
        )
        const catalog = mapValues(modelCatalog, fromModelCatalogProvider)
        const freeCatalog = yield* freeModels.catalog()
        if (freeCatalog.enabled && freeCatalog.models.length)
          catalog[ProviderV2.ID.vector] = fromFreeModels(freeCatalog.models)
        const database = mapValues(catalog, toPublicInfo)

        const providers: Record<ProviderV2.ID, Info> = {} as Record<ProviderV2.ID, Info>
        const languages = new Map<string, LanguageModelV3>()
        const modelLoaders: {
          [providerID: string]: CustomModelLoader
        } = {}
        const varsLoaders: {
          [providerID: string]: CustomVarsLoader
        } = {}
        const sdk = new Map<string, BundledSDK>()
        const discoveryLoaders: {
          [providerID: string]: CustomDiscoverModels
        } = {}
        const dep = {
          auth: (id: string) =>
            auth.get(id).pipe(
              Effect.map((value) =>
                value && !providerCredentialAllowed(id, value, userProviders.has(id)) ? undefined : value,
              ),
              Effect.orDie,
            ),
          config: () => config.get(),
          env: () => env.all(),
          get: (key: string) => env.get(key),
        }

        function mergeProvider(providerID: ProviderV2.ID, provider: Partial<Info>) {
          if (!isProviderAllowed(providerID)) return
          const value = providerAllowed(providerID)
            ? provider
            : { ...provider, source: database[providerID]?.source ?? "custom" }
          const existing = providers[providerID]
          if (existing) {
            // @ts-expect-error
            providers[providerID] = mergeDeep(existing, value)
            return
          }
          const match = database[providerID]
          if (!match) return
          // @ts-expect-error
          providers[providerID] = mergeDeep(match, value)
        }

        // load plugins first so config() hook runs before reading cfg.provider
        const plugins = yield* plugin.list()

        // Runtime consent markers cannot be supplied by project/global config or plugin config hooks.
        for (const provider of Object.values(cfg.provider ?? {}))
          if (provider.options) delete provider.options.vectorOAuthPlugin
        // now read config providers - includes any modifications from plugin config() hook
        const configProviders = Object.entries(cfg.provider ?? {}).filter(([id, provider]) =>
          providerUsable(id, provider),
        )
        const userProviders = new Set([
          ...configProviders.map(([id]) => id),
          ...plugins.flatMap((hook) => [hook.provider?.id, hook.auth?.provider].filter((id) => id !== undefined)),
        ])
        const disabled = new Set(cfg.disabled_providers ?? [])
        const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : null

        function isProviderAllowed(providerID: ProviderV2.ID): boolean {
          if (!providerEnabled(providerID)) return false
          if (!providerAllowed(providerID) && !userProviders.has(providerID)) return false
          if (enabled && !enabled.has(providerID)) return false
          if (disabled.has(providerID)) return false
          return true
        }

        for (const hook of plugins) {
          const p = hook.provider
          const models = p?.models
          if (!p || !models) continue

          const providerID = ProviderV2.ID.make(p.id)
          if (!isProviderAllowed(providerID)) continue

          const provider = database[providerID] ?? {
            id: providerID,
            name: providerID,
            env: [],
            options: {},
            source: "custom" as const,
            models: {},
          }
          database[providerID] = provider
          const storedPluginAuth = yield* auth.get(providerID).pipe(Effect.orDie)
          const pluginAuth =
            storedPluginAuth && providerCredentialAllowed(providerID, storedPluginAuth, userProviders.has(providerID))
              ? storedPluginAuth
              : undefined

          provider.models = yield* Effect.promise(async () => {
            const next = await models(toPublicInfo(provider), { auth: pluginAuth })
            return Object.fromEntries(
              Object.entries(next).map(([id, model]) => [
                id,
                {
                  ...model,
                  id: ModelV2.ID.make(id),
                  providerID,
                },
              ]),
            )
          })
          if (!catalog[providerID]) mergeProvider(providerID, { source: "custom" })
        }

        // extend database from config
        for (const [providerID, provider] of configProviders) {
          const existing = database[providerID]
          const parsed: Info = {
            id: ProviderV2.ID.make(providerID),
            name: provider.name ?? existing?.name ?? providerID,
            env: provider.env ?? existing?.env ?? [],
            options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
            source: "config",
            models: existing?.models ?? {},
          }

          for (const [modelID, model] of Object.entries(provider.models ?? {})) {
            const existingModel = parsed.models[model.id ?? modelID]
            const apiID = model.id ?? existingModel?.api.id ?? modelID
            const apiNpm =
              model.provider?.npm ??
              provider.npm ??
              existingModel?.api.npm ??
              modelCatalog[providerID]?.npm ??
              "@ai-sdk/openai-compatible"
            const name = iife(() => {
              if (model.name) return model.name
              if (model.id && model.id !== modelID) return modelID
              return existingModel?.name ?? modelID
            })
            const parsedModel: Model = {
              id: ModelV2.ID.make(modelID),
              api: {
                id: apiID,
                npm: apiNpm,
                url:
                  model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelCatalog[providerID]?.api ?? "",
              },
              status: model.status ?? existingModel?.status ?? "active",
              name,
              providerID: ProviderV2.ID.make(providerID),
              capabilities: {
                temperature: model.temperature ?? existingModel?.capabilities.temperature ?? false,
                reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
                attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
                toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
                input: {
                  text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
                  audio: model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
                  image: model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
                  video: model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
                  pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
                },
                output: {
                  text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
                  audio:
                    model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
                  image:
                    model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
                  video:
                    model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
                  pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
                },
                interleaved:
                  model.interleaved ??
                  existingModel?.capabilities.interleaved ??
                  (!existingModel && apiNpm === "@ai-sdk/openai-compatible" && apiID.includes("deepseek")
                    ? { field: "reasoning_content" }
                    : false),
              },
              // A config entry without a cost keeps the catalog's pricing whole, long-context tiers included; one
              // with a cost prices the model itself, and its context_over_200k is the long-context rate.
              cost: model.cost
                ? {
                    input: model.cost.input,
                    output: model.cost.output,
                    cache: {
                      read: model.cost.cache_read ?? existingModel?.cost?.cache.read ?? 0,
                      write: model.cost.cache_write ?? existingModel?.cost?.cache.write ?? 0,
                    },
                    ...(model.cost.context_over_200k
                      ? {
                          experimentalOver200K: {
                            input: model.cost.context_over_200k.input,
                            output: model.cost.context_over_200k.output,
                            cache: {
                              read: model.cost.context_over_200k.cache_read ?? 0,
                              write: model.cost.context_over_200k.cache_write ?? 0,
                            },
                          },
                        }
                      : {}),
                  }
                : (existingModel?.cost ?? { ...UNPRICED }),
              options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
              limit: {
                context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
                input: model.limit?.input ?? existingModel?.limit?.input,
                output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
              },
              headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
              family: model.family ?? existingModel?.family ?? "",
              release_date: model.release_date ?? existingModel?.release_date ?? "",
              variants: {},
            }
            const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
            parsedModel.variants = mapValues(
              pickBy(merged, (v) => !v.disabled),
              (v) => omit(v, ["disabled"]),
            )
            parsed.models[modelID] = parsedModel
          }
          database[providerID] = parsed
        }

        // load env
        const envs = yield* env.all()
        for (const [id, provider] of Object.entries(database)) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) continue
          if (!providerEnvironmentAllowed(providerID)) continue
          const apiKey = provider.env.map((item) => envs[item]).find(Boolean)
          if (!apiKey) continue
          mergeProvider(providerID, {
            source: "env",
            key: provider.env.length === 1 ? apiKey : undefined,
          })
        }

        // load apikeys
        const auths = yield* auth.all().pipe(Effect.orDie)
        for (const [id, provider] of Object.entries(auths)) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) continue
          if (
            provider.type === "api" &&
            providerCredentialAllowed(providerID, provider, userProviders.has(providerID))
          ) {
            mergeProvider(providerID, {
              source: "api",
              key: provider.key,
            })
          }
        }

        // plugin auth loader - database now has entries for config providers
        for (const plugin of plugins) {
          if (!plugin.auth) continue
          const providerID = ProviderV2.ID.make(plugin.auth.provider)
          if (!isProviderAllowed(providerID)) continue

          const stored = yield* auth.get(providerID).pipe(Effect.orDie)
          if (!stored) continue
          if (!providerCredentialAllowed(providerID, stored, userProviders.has(providerID))) continue
          if (!plugin.auth.loader || !database[providerID]) continue

          const options = yield* Effect.promise(() =>
            plugin.auth!.loader!(
              () => bridge.promise(auth.get(providerID).pipe(Effect.orDie)) as any,
              toPublicInfo(database[plugin.auth!.provider]),
            ),
          )
          const opts = options ?? {}
          const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
          mergeProvider(providerID, patch)
        }

        for (const [id, fn] of Object.entries(custom(dep))) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) continue
          const data = database[providerID]
          if (!data) {
            continue
          }
          const result = yield* fn(data)
          if (result && (result.autoload || providers[providerID])) {
            if (result.getModel) modelLoaders[providerID] = result.getModel
            if (result.vars) varsLoaders[providerID] = result.vars
            if (result.discoverModels) discoveryLoaders[providerID] = result.discoverModels
            const opts = result.options ?? {}
            const patch: Partial<Info> = providers[providerID] ? { options: opts } : { source: "custom", options: opts }
            mergeProvider(providerID, patch)
          }
        }

        // load config - re-apply with updated data
        for (const [id, provider] of configProviders) {
          const providerID = ProviderV2.ID.make(id)
          const partial: Partial<Info> = { source: "config" }
          if (provider.env) partial.env = provider.env
          if (provider.name) partial.name = provider.name
          if (provider.options) partial.options = provider.options
          mergeProvider(providerID, partial)
        }

        // Built-in free credentials and destinations cannot be replaced by project configuration.
        const vectorToken = yield* freeCredentials.get("vector")
        const openRouterKey = yield* freeCredentials.get("openrouter")
        const ownedFree = openRouterKey ? yield* freeModels.forKey(openRouterKey) : []
        const router = providers[ProviderV2.ID.openrouter]
        if (router) {
          for (const modelID of Object.keys(router.models)) {
            if (modelID.toLowerCase().endsWith(":free")) delete router.models[modelID]
          }
        }
        delete providers[ProviderV2.ID.vector]
        if (freeCatalog.enabled && isProviderAllowed(ProviderV2.ID.vector) && (vectorToken || openRouterKey)) {
          const models = openRouterKey ? ownedFree : freeCatalog.models
          if (models.length) providers[ProviderV2.ID.vector] = fromFreeModels(models)
        }
        if (!freeCatalog.enabled) delete providers[ProviderV2.ID.vector]
        if (openRouterKey && isProviderAllowed(ProviderV2.ID.openrouter)) {
          providers[ProviderV2.ID.openrouter] ??= fromFreeModels([], "openrouter")
          Object.assign(providers[ProviderV2.ID.openrouter].models, fromFreeModels(ownedFree, "openrouter").models)
        }

        const gitlab = ProviderV2.ID.make("gitlab")
        if (discoveryLoaders[gitlab] && providers[gitlab] && isProviderAllowed(gitlab)) {
          yield* Effect.promise(async () => {
            try {
              const discovered = await discoveryLoaders[gitlab]()
              for (const [modelID, model] of Object.entries(discovered)) {
                if (!providers[gitlab].models[modelID]) {
                  providers[gitlab].models[modelID] = model
                }
              }
            } catch (e) {}
          })
        }

        for (const [id, provider] of Object.entries(providers)) {
          const providerID = ProviderV2.ID.make(id)
          if (!isProviderAllowed(providerID)) {
            delete providers[providerID]
            continue
          }

          delete provider.options.vectorOAuthPlugin
          const approval = activeOAuthApproval(providerID)
          if (approval) provider.options.vectorOAuthPlugin = approval.id
          const configProvider = cfg.provider?.[providerID]

          for (const [modelID, model] of Object.entries(provider.models)) {
            model.api.id = model.api.id ?? model.id ?? modelID
            if (
              // These chat aliases are invalid for the special handling in the
              // built-in providers below, but custom providers may support them.
              (modelID === "gpt-5-chat-latest" &&
                (providerID === ProviderV2.ID.openai ||
                  providerID === ProviderV2.ID.githubCopilot ||
                  providerID === ProviderV2.ID.openrouter)) ||
              (providerID === ProviderV2.ID.openrouter && modelID === "openai/gpt-5-chat")
            )
              delete provider.models[modelID]
            // Every catalogue model is listed, alpha and beta included; only retired ones go.
            if (model.status === "deprecated") delete provider.models[modelID]
            if (
              (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
              (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
            )
              delete provider.models[modelID]

            if (!model.variants || Object.keys(model.variants).length === 0) {
              model.variants = mapValues(ProviderTransform.variants(model), (v) => v)
            }

            const configVariants = configProvider?.models?.[modelID]?.variants
            if (configVariants && model.variants) {
              const merged = mergeDeep(model.variants, configVariants)
              model.variants = mapValues(
                pickBy(merged, (v) => !v.disabled),
                (v) => omit(v, ["disabled"]),
              )
            }
          }

          // Keep a connected free account visible when discovery or filters leave it empty.
          // Otherwise downstream default selection could mistake a paid provider for the only choice.
          if (Object.keys(provider.models).length === 0 && !(providerID === "openrouter" && openRouterKey)) {
            delete providers[providerID]
            continue
          }
        }

        const unavailable = Object.entries(auths).flatMap(([id, credential]) => {
          if (credential.type === "wellknown") return []
          const rejected = providerCredentialUnavailable(id, credential, userProviders.has(id))
          if (rejected) return [rejected]
          if (disabled.has(id) || (enabled && !enabled.has(id))) return [providerUnavailable(id, "disabled")]
          if (!providers[ProviderV2.ID.make(id)]) return [providerUnavailable(id, "no-models")]
          return []
        })
        for (const notice of unavailable) yield* Effect.logWarning(notice.message)

        return {
          models: languages,
          providers,
          unavailable,
          declared: new Set([
            ...Object.keys(cfg.provider ?? {}),
            ...(cfg.disabled_providers ?? []),
            ...(cfg.enabled_providers ?? []),
            ...userProviders,
          ]),
          catalog,
          sdk,
          modelLoaders,
          varsLoaders,
        }
      }),
    )

    const list = Effect.fn("Provider.list")(() => InstanceState.use(state, (s) => s.providers))

    const unavailable = Effect.fn("Provider.unavailable")(() => InstanceState.use(state, (s) => s.unavailable))

    async function resolveSDK(model: Model, s: State, envs: Record<string, string | undefined>) {
      try {
        const provider = s.providers[model.providerID]
        if (
          model.providerID === "vector" ||
          model.freeModel ||
          (model.providerID === "openrouter" && model.id.toLowerCase().endsWith(":free"))
        ) {
          const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible")
          return createOpenAICompatible({
            name: model.providerID,
            baseURL: "https://vectordev.ai/api/free-models",
            apiKey: "vector-request-credential",
            fetch: Object.assign(
              async (_input: RequestInfo | URL, init?: RequestInit) => {
                const route = await FreeModels.resolveRoute({
                  provider: model.providerID === "vector" ? "vector" : "openrouter",
                  modelID: model.id,
                  catalog: () => runtimeBridge.promise(freeModels.catalog()),
                  forKey: (key) => runtimeBridge.promise(freeModels.forKey(key)),
                  credential: (provider) => runtimeBridge.promise(freeCredentials.get(provider)),
                })
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
                return fetch(route.url, {
                  method: "POST",
                  redirect: "error",
                  signal: init?.signal,
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${route.key}`,
                    "HTTP-Referer": "https://vectordev.ai/",
                    "X-OpenRouter-Title": "Vector",
                  },
                  body: serializeFreeModelRequest(
                    freeModelRequest({ ...body, model: model.id }, route.models, route.source === "openrouter"),
                    route.url === FreeModels.SHARED_CHAT_URL,
                  ),
                }).then(FreeModels.preserveLimit)
              },
              { preconnect: fetch.preconnect },
            ),
          })
        }
        const options = { ...provider.options }
        const credential = await runtimeBridge.promise(auth.get(model.providerID).pipe(Effect.orDie))
        const consentID = credential?.type !== "wellknown" ? credential?.metadata?.vector_plugin_oauth : undefined
        const consent = typeof consentID === "string" ? activeOAuthApproval(model.providerID, consentID) : undefined
        if (consentID && (!consent || !pluginCredentialAllowed(model.providerID, credential!)))
          throw new Error("Plugin OAuth approval changed. Reconnect to continue.")

        if (
          model.providerID === "google-vertex" &&
          model.api.npm === "@ai-sdk/google-vertex/anthropic" &&
          !options.baseURL
        ) {
          const baseURL = googleVertexAnthropicBaseURL(
            typeof options.project === "string" ? options.project : undefined,
            typeof options.location === "string" ? options.location : undefined,
          )
          if (baseURL) options.baseURL = baseURL
        }

        if (model.providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
          delete options.fetch
        }

        if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
          options["includeUsage"] = true
        }

        const baseURL = iife(() => {
          let url =
            typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
          if (!url) return

          const loader = s.varsLoaders[model.providerID]
          if (loader) {
            const vars = loader(options)
            for (const [key, value] of Object.entries(vars)) {
              const field = "${" + key + "}"
              url = url.replaceAll(field, value)
            }
          }

          url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
            const val = envs[String(key)]
            return val ?? item
          })
          return url
        })

        if (baseURL !== undefined) options["baseURL"] = baseURL
        if (consent) requirePluginDestination(consent, baseURL)
        if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
        if (model.providerID === "gitlab") {
          if (credential?.type === "oauth" && !consent && options.apiKey === credential.access)
            options.instanceUrl = requireGitlabOAuthEndpoint(credential, options)
        }
        if (model.headers)
          options["headers"] = {
            ...options["headers"],
            ...model.headers,
          }

        const key = Hash.fast(
          JSON.stringify({
            providerID: model.providerID,
            npm: model.api.npm,
            options,
          }),
        )
        const existing = s.sdk.get(key)
        if (existing) return existing

        const customFetch = options["fetch"]
        const chunkTimeout = options["chunkTimeout"]
        const headerTimeout = options["headerTimeout"]
        delete options["chunkTimeout"]
        delete options["headerTimeout"]

        options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
          const fetchFn = customFetch ?? fetch
          const opts = { ...init }
          if (consent) {
            requirePluginDestination(consent, input instanceof Request ? input.url : String(input))
            const current = await runtimeBridge.promise(auth.get(model.providerID).pipe(Effect.orDie))
            if (
              !current ||
              current.type === "wellknown" ||
              current.metadata?.vector_plugin_oauth !== consent.id ||
              !pluginCredentialAllowed(model.providerID, current)
            )
              throw new Error("Plugin OAuth approval or credential changed. Reconnect to continue.")
            opts.redirect = "error"
          }
          const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
          const headerTimeoutMs = headerTimeout === false ? undefined : headerTimeout
          const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
          const signals: AbortSignal[] = []

          if (opts.signal) signals.push(opts.signal)
          if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
          if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
          if (options["timeout"] !== undefined && options["timeout"] !== null && options["timeout"] !== false)
            signals.push(AbortSignal.timeout(options["timeout"]))

          const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
          if (combined) opts.signal = combined

          const res = await fetchFn(input, {
            ...opts,
            // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
            timeout: false,
          }).finally(() => headerTimeoutCtl?.clear())

          if (!chunkAbortCtl) return res
          return wrapSSE(res, chunkTimeout, chunkAbortCtl)
        }

        const bundledLoader = BUNDLED_PROVIDERS[model.api.npm]
        if (bundledLoader) {
          const factory = await bundledLoader()
          const loaded = factory({
            name: model.providerID,
            ...options,
          })
          s.sdk.set(key, loaded)
          return loaded as SDK
        }

        const installedPath = await (async () => {
          if (model.api.npm.startsWith("file://")) {
            return model.api.npm
          }
          const item = await Npm.add(model.api.npm)
          if (!item.entrypoint) throw new Error(`Package ${model.api.npm} has no import entrypoint`)
          return item.entrypoint
        })()

        // `installedPath` is a local entry path or an existing `file://` URL. Normalize
        // only path inputs so Node on Windows accepts the dynamic import.
        const importSpec = installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
        const mod = await import(importSpec)

        const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
        const loaded = fn({
          name: model.providerID,
          ...options,
        })
        s.sdk.set(key, loaded)
        return loaded as SDK
      } catch (e) {
        throw new InitError({ providerID: model.providerID, cause: e })
      }
    }

    const getProvider = Effect.fn("Provider.getProvider")((providerID: ProviderV2.ID) =>
      InstanceState.use(state, (s) => s.providers[providerID]),
    )

    const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderV2.ID, modelID: ModelV2.ID) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) {
        const catalogProvider = s.catalog[providerID]
        const suggestions = catalogProvider
          ? modelSuggestions(catalogProvider, modelID)
          : fuzzysort
              .go(providerID, Object.keys({ ...s.catalog, ...s.providers }), { limit: 3, threshold: -10000 })
              .map((m) => m.target)
        return yield* new ModelNotFoundError({
          providerID,
          modelID,
          suggestions,
          unavailable: s.unavailable.find((item) => item.id === providerID),
        })
      }

      const info = provider.models[modelID]
      if (!info) {
        const current = modelSuggestions(provider, modelID)
        const suggestions = current.length ? current : modelSuggestions(s.catalog[providerID], modelID)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }
      return info
    })

    const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
      const s = yield* InstanceState.get(state)
      const envs = yield* env.all()
      const key = `${model.providerID}/${model.id}`
      if (s.models.has(key)) return s.models.get(key)!

      const provider = s.providers[model.providerID]
      return yield* EffectPromise.refineRejection(
        async () => {
          const sdk = await resolveSDK(model, s, envs)
          const language = s.modelLoaders[model.providerID]
            ? await s.modelLoaders[model.providerID](
                sdk,
                model.api.id,
                {
                  ...provider.options,
                  ...model.options,
                },
                model,
              )
            : sdk.languageModel(model.api.id)
          s.models.set(key, language)
          return language
        },
        (cause) =>
          cause instanceof NoSuchModelError
            ? new ModelNotFoundError({ modelID: model.id, providerID: model.providerID, cause })
            : undefined,
      )
    })

    const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderV2.ID, query: string[]) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined
      for (const item of query) {
        for (const modelID of Object.keys(provider.models)) {
          if (modelID.includes(item)) return { providerID, modelID }
        }
      }
      return undefined
    })

    const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (
      providerID: ProviderV2.ID,
      primaryID?: ModelV2.ID,
    ) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined
      const primary = primaryID ? provider.models[primaryID] : undefined
      // Background calls must not turn a free conversation into paid inference, even with a small-model override.
      if (primary && isFreeModel(primary)) return primary
      if (providerID === "vector") return Object.values(provider.models).find(isFreeModel)
      const cfg = yield* config.get()

      if (cfg.small_model) {
        const parsed = parseModel(cfg.small_model)
        return yield* getModel(parsed.providerID, parsed.modelID).pipe(
          Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)),
        )
      }

      const experimental = yield* plugin.trigger<"experimental.provider.small_model">(
        "experimental.provider.small_model",
        { provider: toPublicInfo(provider) },
        { model: undefined },
      )
      if (experimental.model) {
        return {
          ...experimental.model,
          id: ModelV2.ID.make(experimental.model.id),
          providerID: ProviderV2.ID.make(experimental.model.providerID),
        }
      }

      // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
      if (providerID === ProviderV2.ID.azure || providerID === ProviderV2.ID.make("azure-cognitive-services")) {
        return undefined
      }

      const priority = providerID.startsWith("github-copilot")
        ? ["gpt-mini", ...smallModelFamilyPriority]
        : smallModelFamilyPriority
      const models = sortBy(
        Object.values(provider.models),
        [(model) => model.release_date, "desc"],
        [(model) => model.id, "desc"],
      )
      for (const family of priority) {
        const candidates = models.filter((model) => model.family === family)
        if (providerID === ProviderV2.ID.amazonBedrock) {
          const crossRegionPrefixes = ["global.", "us.", "eu."]

          const globalMatch = candidates.find((model) => model.id.startsWith("global."))
          if (globalMatch) return globalMatch

          const region = provider.options?.region
          if (region) {
            const regionPrefix = region.split("-")[0]
            if (regionPrefix === "us" || regionPrefix === "eu") {
              const regionalMatch = candidates.find((model) => model.id.startsWith(`${regionPrefix}.`))
              if (regionalMatch) return regionalMatch
            }
          }

          const unprefixed = candidates.find((model) => !crossRegionPrefixes.some((p) => model.id.startsWith(p)))
          if (unprefixed) return unprefixed
          continue
        }
        if (candidates[0]) return candidates[0]
      }

      return undefined
    })

    const savedModel = Effect.fn("Provider.savedModel")(function* (model: { providerID: string; modelID: string }) {
      const s = yield* InstanceState.get(state)
      const current = renamedModel(model)
      if (
        current.providerID === "vector" &&
        s.providers[ProviderV2.ID.openrouter]?.models[current.modelID]?.freeModel?.source === "openrouter"
      )
        return { providerID: ProviderV2.ID.openrouter, modelID: ModelV2.ID.make(current.modelID) }
      if (providerRetired(current.providerID, (id) => s.declared.has(id) || id in s.providers)) return
      return { providerID: ProviderV2.ID.make(current.providerID), modelID: ModelV2.ID.make(current.modelID) }
    })

    const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
      const cfg = yield* config.get()
      const saved = cfg.model ? yield* savedModel(parseModel(cfg.model)) : undefined
      if (saved && providerEnabled(saved.providerID)) return saved

      const s = yield* InstanceState.get(state)
      const recent = yield* fs.readJson(path.join(Global.Path.state, "model.json")).pipe(
        Effect.map((x): { providerID: ProviderV2.ID; modelID: ModelV2.ID }[] => {
          if (!isRecord(x) || !Array.isArray(x.recent)) return []
          return x.recent.flatMap((item) => {
            if (!isRecord(item)) return []
            if (typeof item.providerID !== "string") return []
            if (typeof item.modelID !== "string") return []
            const model = renamedModel({ providerID: item.providerID, modelID: item.modelID })
            return [{ providerID: ProviderV2.ID.make(model.providerID), modelID: ModelV2.ID.make(model.modelID) }]
          })
        }),
        Effect.catch(() => Effect.succeed([] as { providerID: ProviderV2.ID; modelID: ModelV2.ID }[])),
      )
      for (const entry of recent) {
        const owned = s.providers[ProviderV2.ID.openrouter]?.models[entry.modelID]
        if (entry.providerID === "vector" && owned?.freeModel?.source === "openrouter")
          return { providerID: ProviderV2.ID.openrouter, modelID: owned.id }
        const provider = s.providers[entry.providerID]
        // A vanished free choice must fail as unavailable, never quietly select a paid model.
        if (["vector", "openrouter"].includes(entry.providerID) && entry.modelID.toLowerCase().endsWith(":free"))
          return entry
        if (!provider) continue
        if (!provider.models[entry.modelID]) continue
        return { providerID: entry.providerID, modelID: entry.modelID }
      }

      const configured = Object.keys(cfg.provider ?? {})
      const providers = Object.values(s.providers).filter((p) => configured.length === 0 || configured.includes(p.id))
      const free = sort(Object.values(s.providers).flatMap((provider) => Object.values(provider.models))).find(
        (model) => model.freeModel?.source === "openrouter",
      )
      if (free) return { providerID: free.providerID, modelID: free.id }
      if (s.providers[ProviderV2.ID.openrouter])
        return yield* new NoModelsError({ providerID: ProviderV2.ID.openrouter })
      const provider = providers.find((p) => p.id !== "vector") ?? providers[0]
      if (!provider) return yield* new NoProvidersError()
      const [model] = sort(Object.values(provider.models))
      if (!model) return yield* new NoModelsError({ providerID: provider.id })
      return {
        providerID: provider.id,
        modelID: model.id,
      }
    })

    return Service.of({
      list,
      unavailable,
      getProvider,
      getModel,
      getLanguage,
      closest,
      getSmallModel,
      defaultModel,
      savedModel,
    })
  }),
)

const priority = ["gpt-5", "claude-sonnet-4", "gemini-3-pro"]
const smallModelFamilyPriority = ["gemini-flash", "gpt-nano", "claude-haiku"]
export function sort<
  T extends { id: string; freeModel?: { source: "shared" | "openrouter" }; limit?: { context: number } },
>(models: T[]) {
  return sortBy(
    models,
    [(model) => (model.freeModel?.source === "openrouter" ? 0 : 1), "asc"],
    [(model) => (model.freeModel?.source === "openrouter" ? (model.limit?.context ?? 0) : 0), "desc"],
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.id, "desc"],
  )
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ModelV2.ID.make(rest.join("/")),
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    FSUtil.node,
    Config.node,
    Auth.node,
    Env.node,
    Plugin.node,
    ModelCatalog.node,
    RuntimeFlags.node,
    FreeModels.node,
    FreeModels.credentialsNode,
  ],
})

export * as Provider from "./provider"
