import type { Config, VectorClient } from "@vectordevai/sdk/v2/client"
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

  if (input.result.key) {
    // The server checks again while holding the credential-store filesystem lock.
    const saved = await input.client.auth.set(
      { providerID, ifAbsent: "true", auth: { type: "api", key: input.result.key } },
      { throwOnError: false },
    )
    if (saved.response.status === 409) throw new Error(input.conflictMessage)
    if (saved.error) throw new Error("message" in saved.error ? saved.error.message : String(saved.error))
  }

  await input.updateConfig({ provider: { [providerID]: input.result.config } })
}
