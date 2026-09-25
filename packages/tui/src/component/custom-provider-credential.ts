import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { providerAllowed } from "@vectordevai/schema/provider-policy"

export async function saveCustomProviderCredential(client: VectorClient, providerID: string, key: string) {
  const [providers, config, credential] = await Promise.all([
    client.provider.list({}, { throwOnError: true }),
    client.config.get({}, { throwOnError: true }),
    client.auth.exists({ providerID }, { throwOnError: true }),
  ])
  const conflict = "That provider ID already exists. Choose a different ID for a new custom provider."
  if (
    providerAllowed(providerID) ||
    providers.data.all.some((provider) => provider.id === providerID) ||
    providers.data.connected.includes(providerID) ||
    Object.hasOwn(config.data.provider ?? {}, providerID) ||
    config.data.disabled_providers?.includes(providerID) ||
    credential.data
  ) {
    throw new Error(conflict)
  }
  const saved = await client.auth.set(
    { providerID, ifAbsent: "true", auth: { type: "api", key } },
    { throwOnError: false },
  )
  if (saved.response.status === 409) throw new Error(conflict)
  if (saved.error) throw new Error("message" in saved.error ? saved.error.message : String(saved.error))
}
