import { copilotOAuthConfiguration, ownedOAuthMatches } from "@vectordevai/core/provider-policy"
import type { Hooks, PluginInput } from "@vectordevai/plugin"
import type { Model } from "@vectordevai/sdk/v2"
import { InstallationVersion } from "@vectordevai/core/installation/version"
import { createDeviceOAuth } from "@vectordevai/core/oauth/device"
import { CopilotModels } from "./models"
import { copilotFetch } from "@vectordevai/core/oauth/copilot"

const API_VERSION = "2026-06-01"
const UTILITY_MODELS = ["gpt-5.4-nano", "gpt-4.1", "gpt-4o", "gpt-4o-mini"]
const base = () => "https://api.githubcopilot.com"

function fix(model: Model, url: string): Model {
  return {
    ...model,
    api: {
      ...model.api,
      url,
      npm: "@ai-sdk/github-copilot",
    },
  }
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  return copilotAuthHooks(input, copilotOAuthConfiguration)
}
export function copilotAuthHooks(
  input: PluginInput,
  configuration = copilotOAuthConfiguration,
  oauth = createDeviceOAuth(),
): Hooks {
  if (!configuration()) return { auth: { provider: "github-copilot", methods: [] } }
  let active = new AbortController()
  const registration = () => {
    const app = configuration()
    if (!app) throw new Error("Copilot sign-in is not enabled for this Vector build.")
    return app
  }
  let models: Record<string, Model> = {}
  return {
    async dispose() {
      active.abort()
    },
    provider: {
      id: "github-copilot",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth" || !ownedOAuthMatches(ctx.auth, configuration())) {
          models = {}
          return Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, fix(model, base())]))
        }

        const auth = ctx.auth

        return CopilotModels.get(
          base(),
          {
            ...(provider.options?.headers as Record<string, string> | undefined),
            Authorization: `Bearer ${auth.access}`,
            "User-Agent": `vector/${InstallationVersion}`,
            "X-GitHub-Api-Version": API_VERSION,
          },
          provider.models,
        )
          .then((result) => {
            models = result.models
            return Object.fromEntries(
              Object.entries(result.models).filter(([, model]) => result.pickerEnabled.has(model.api.id)),
            )
          })
          .catch((error) => {
            models = {}
            return Object.fromEntries(Object.entries(provider.models).map(([id, model]) => [id, fix(model, base())]))
          })
      },
    },
    auth: {
      provider: "github-copilot",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info || info.type !== "oauth" || !ownedOAuthMatches(info, configuration())) return {}

        return {
          apiKey: "",
          fetch: copilotFetch(async () => {
            const saved = await getAuth()
            if (saved.type !== "oauth" || !ownedOAuthMatches(saved, configuration()))
              throw new Error("Copilot registration changed. Sign in again.")
            const value =
              saved.expires > Date.now() + 60_000
                ? saved
                : await oauth.refresh(registration(), saved.refresh, active.signal)
            if (!ownedOAuthMatches(value, configuration()))
              throw new Error("Copilot registration changed. Sign in again.")
            if (value !== saved)
              await input.client.auth.set({ path: { id: "github-copilot" }, body: { ...value, type: "oauth" } })
            return value.access
          }),
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          async authorize() {
            active.abort()
            active = new AbortController()
            const device = await oauth.authorize(registration(), active.signal, true)
            return {
              method: "auto" as const,
              url: device.url,
              instructions: device.instructions,
              async callback() {
                const value = await device.complete()
                if (!ownedOAuthMatches(value, configuration()))
                  throw new Error("Copilot registration changed. Sign in again.")
                return { ...value, type: "success" as const }
              },
            }
          },
        },
      ],
    },
    "chat.params": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      // Match github copilot cli, omit maxOutputTokens for gpt models
      if (incoming.model.api.id.includes("gpt")) {
        output.maxOutputTokens = undefined
      }

      // GitHub Copilot's /v1/messages shim rejects the GA `eager_input_streaming`
      // field on tool definitions ("Extra inputs are not permitted"). Opt out of
      // the @ai-sdk/anthropic default so it stops injecting the field.
      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.options.toolStreaming = false
      }
    },
    "experimental.provider.small_model": async (incoming, output) => {
      if (incoming.provider.id !== "github-copilot") return
      // GitHub exposes utility models for title generation without including them in the picker.
      output.model = UTILITY_MODELS.map((id) => models[id]).find((model) => model !== undefined)
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      output.headers["X-GitHub-Api-Version"] = API_VERSION
      if (incoming.agent === "title") {
        output.headers["X-Interaction-Type"] = "agent-session-name-generation"
      }

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      // Use the actual request role for attribution. Do not force compaction or
      // subagents to a cheaper category without GitHub's written partner guidance.
    },
  }
}
