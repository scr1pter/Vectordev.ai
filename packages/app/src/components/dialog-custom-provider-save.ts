import type { Config, VectorClient } from "@vectordevai/sdk/v2/client"
import type { LocalProbe } from "@vectordevai/core/local-mode/probe"
import { providerAllowed } from "@vectordevai/schema/provider-policy"
import type { validateCustomProvider } from "./dialog-custom-provider-form"

export async function saveCustomProvider(input: {
  client: VectorClient
  result: NonNullable<ReturnType<typeof validateCustomProvider>["result"]>
  directory?: string
  conflictMessage: string
  updateConfig: (config: Config) => Promise<unknown>
}) {
  const providerID = input.result.providerID
  const [providers, config, credential] = await Promise.all([
    input.client.provider.list({ directory: input.directory }, { throwOnError: true }),
    input.client.config.get({ directory: input.directory }, { throwOnError: true }),
    input.client.auth.exists({ providerID }, { throwOnError: true }),
  ])
  if (
    providerAllowed(providerID) ||
    providers.data.all.some((provider) => provider.id === providerID) ||
    providers.data.connected.includes(providerID) ||
    Object.hasOwn(config.data.provider ?? {}, providerID) ||
    config.data.disabled_providers?.includes(providerID) ||
    credential.data
  ) {
    throw new Error(input.conflictMessage)
  }

  // The server list lives in the user's global config, and a config update replaces a list, so it is read from there
  // (never from the merged config, which also holds a company's entries) before this server is added to it.
  const local = input.result.local
    ? listed((await input.client.global.config.get({ throwOnError: true })).data.local, input.result.local)
    : undefined

  if (input.result.key) {
    // The server checks again while holding the credential-store filesystem lock.
    const saved = await input.client.auth.set(
      { providerID, ifAbsent: "true", auth: { type: "api", key: input.result.key } },
      { throwOnError: false },
    )
    if (saved.response.status === 409) throw new Error(input.conflictMessage)
    if (saved.error) throw new Error("message" in saved.error ? saved.error.message : String(saved.error))
  }

  await input.updateConfig({ provider: { [providerID]: input.result.config }, ...(local ? { local } : {}) })
}

/** The global `local` block's list and pins with this server added: on the list once, pinned as it answered now. */
export function listed(
  current: Config["local"],
  server: { readonly origin: string; readonly pin: LocalProbe.Pin },
): NonNullable<Config["local"]> {
  const endpoints = current?.endpoints ?? []
  return {
    endpoints: endpoints.includes(server.origin) ? endpoints : [...endpoints, server.origin],
    pins: {
      ...current?.pins,
      [server.origin]: {
        kind: server.pin.kind,
        ...(server.pin.version === undefined ? {} : { version: server.pin.version }),
        ...(server.pin.models === undefined ? {} : { models: server.pin.models }),
        ...(server.pin.spki ? { spki: server.pin.spki } : {}),
      },
    },
  }
}
