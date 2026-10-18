import { describe, expect, test } from "bun:test"
import { FREE_MODEL_TRAINING_DISCLAIMER, FREE_ROUTER_DISCLAIMER } from "@vectordevai/core/free-model-choice"
import { EOL } from "os"
import { freeModelRunNotice } from "@/cli/cmd/run/free-model-notice"

describe("vector run's notice for a free model labelled May train on your prompts", () => {
  const laguna = {
    id: "poolside/laguna-s-2.1:free",
    name: "Poolside: Laguna S 2.1",
    freeModel: { source: "shared" as const, dataPolicy: "may-train" as const },
  }
  const north = {
    id: "cohere/north-mini-code:free",
    name: "Cohere: North Mini Code",
    freeModel: { source: "shared" as const, dataPolicy: "no-training" as const },
  }
  const router = { id: "openrouter/free", name: "Free Models Router", freeModel: laguna.freeModel }
  const providers = [
    { id: "vector", models: { [laguna.id]: laguna, [north.id]: north, [router.id]: router } },
    { id: "anthropic", models: { "claude-sonnet": { id: "claude-sonnet", name: "Claude Sonnet" } } },
    {
      id: "openrouter",
      models: {
        [laguna.id]: { ...laguna, freeModel: { source: "openrouter" as const, dataPolicy: "unreviewed" as const } },
      },
    },
  ]

  test("names the model, where it runs and its label, then the disclaimer", () => {
    expect(freeModelRunNotice(providers, { providerID: "vector", modelID: laguna.id })).toBe(
      `Free models inside of Vector: Poolside: Laguna S 2.1 · Shared Vector allowance · May train on your prompts${EOL}${FREE_MODEL_TRAINING_DISCLAIMER}`,
    )
    expect(freeModelRunNotice(providers, { providerID: "openrouter", modelID: laguna.id })).toContain(
      "Your OpenRouter account · May train on your prompts",
    )
    expect(freeModelRunNotice(providers, { providerID: "vector", modelID: router.id })).toEndWith(
      FREE_ROUTER_DISCLAIMER,
    )
  })

  test("says nothing for a no-training, paid or unknown model, or when the model is not known yet", () => {
    expect(freeModelRunNotice(providers, { providerID: "vector", modelID: north.id })).toBeUndefined()
    expect(freeModelRunNotice(providers, { providerID: "anthropic", modelID: "claude-sonnet" })).toBeUndefined()
    expect(freeModelRunNotice(providers, { providerID: "vector", modelID: "maker/gone:free" })).toBeUndefined()
    expect(freeModelRunNotice(providers, undefined)).toBeUndefined()
  })
})
