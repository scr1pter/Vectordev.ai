import { expect, test } from "bun:test"
import { freeModelsStartHint } from "../../src/routes/home"

const model = (source: "shared" | "openrouter") => ({ models: { "maker/coder:free": { freeModel: { source } } } })

test("with nothing connected the home screen offers signing in to Vector for free models, never an OpenRouter account", () => {
  // The owner's decision of 17 October 2026: free models run on Vector's shared allowance for every signed-in
  // account, so the free way to start is signing in to Vector.
  expect(freeModelsStartHint({ provider: [], provider_next: { all: [model("shared")] } })).toBe(
    "Sign in to Vector to use free models: run vector login. Or use /connect to connect a provider with your own key.",
  )
  // With no shared models listed, the shared allowance serves nothing right now: say so, and offer a key.
  for (const all of [[], [{ models: { paid: {} } }]])
    expect(freeModelsStartHint({ provider: [], provider_next: { all } })).toBe(
      "Free models inside of Vector are unavailable right now. Use /connect to connect a provider with your own key.",
    )
  for (const all of [[], [model("shared")]])
    expect(freeModelsStartHint({ provider: [], provider_next: { all } })).not.toMatch(/openrouter/i)
  // A connected provider needs no hint.
  expect(freeModelsStartHint({ provider: [{}], provider_next: { all: [model("shared")] } })).toBeUndefined()
})
