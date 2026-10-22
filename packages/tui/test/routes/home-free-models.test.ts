import { expect, test } from "bun:test"
import {
  FREE_MODEL_TRAINING_DISCLAIMER,
  FREE_MODEL_TRAINING_LABEL,
  FREE_MODELS_DATA_POLICY,
  FREE_MODELS_SHARED_COPY,
} from "@vectordevai/core/free-model-choice"
import { freeModelsStartNotice } from "../../src/routes/home"

const model = (source: "shared" | "openrouter") => ({ models: { "maker/coder:free": { freeModel: { source } } } })

test("with nothing connected the home screen offers signing in to Vector for free models, never an OpenRouter account", () => {
  // The owner's decision of 17 October 2026: free models run on Vector's shared allowance for every signed-in
  // account, so the free way to start is signing in to Vector.
  expect(freeModelsStartNotice({ provider: [], provider_next: { all: [model("shared")] } })).toEqual([
    "Sign in to Vector to use free models: run vector login. Or use /connect to connect a provider with your own key.",
    FREE_MODELS_SHARED_COPY,
  ])
  // With no shared models listed, the shared allowance serves nothing right now: say so, and offer a key.
  for (const all of [[], [{ models: { paid: {} } }]])
    expect(freeModelsStartNotice({ provider: [], provider_next: { all } })?.[0]).toBe(
      "Free models inside of Vector are unavailable right now. Use /connect to connect a provider with your own key.",
    )
  for (const all of [[], [model("shared")]])
    expect(freeModelsStartNotice({ provider: [], provider_next: { all } })?.join(" ")).not.toMatch(/openrouter/i)
  // A connected provider needs no notice.
  expect(freeModelsStartNotice({ provider: [{}], provider_next: { all: [model("shared")] } })).toBeUndefined()
})

test("the home free-models notice holds no disclaimer, only how to start and the shared-allowance sentence", () => {
  // The one-time acceptance question is the one place that explains the label; every notice shows the label alone.
  for (const all of [[], [model("shared")], [model("openrouter")]]) {
    const lines = freeModelsStartNotice({ provider: [], provider_next: { all } })
    expect(lines).toHaveLength(2)
    expect(lines?.[1]).toBe(FREE_MODELS_SHARED_COPY)
    const text = lines?.join(" ") ?? ""
    expect(text).not.toContain(FREE_MODELS_DATA_POLICY)
    expect(text).not.toContain(FREE_MODEL_TRAINING_DISCLAIMER)
    expect(text).not.toContain(FREE_MODEL_TRAINING_LABEL)
    expect(text).not.toMatch(/retention|train|log your prompts|keep prompts/i)
  }
})
