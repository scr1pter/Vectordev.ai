import type { Hooks } from "@opencode-ai/plugin"
import { POE_SIGN_IN } from "@opencode-ai/core/provider-policy"

export async function PoeAuthPlugin(): Promise<Hooks> {
  // A Vector-owned Poe registration is required before adding a sign-in method.
  if (POE_SIGN_IN) throw new Error("Configure Vector's Poe OAuth registration before enabling sign-in")
  return { auth: { provider: "poe", methods: [{ type: "api", label: "Poe API key" }] } }
}
