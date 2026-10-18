import { expect, test } from "bun:test"
import { freeModelsStartHint } from "../../src/routes/home"

const model = (source: "shared" | "openrouter") => ({ models: { "maker/coder:free": { freeModel: { source } } } })

test("with nothing connected the home screen offers Connect OpenRouter, even while the shared catalog is off", () => {
  // Root cause 3 (17 Oct 2026): the block was shown only when the shared catalog listed free models, so with it OFF a
  // new user saw no free way to start.
  expect(freeModelsStartHint({ provider: [], provider_next: { all: [] } })).toBe(
    "Use /connect to choose OpenRouter and use free models with your own account.",
  )
  expect(freeModelsStartHint({ provider: [], provider_next: { all: [{ models: { paid: {} } }] } })).toContain(
    "/connect to choose OpenRouter",
  )
  // Signing in for the shared allowance is offered only while it serves models.
  expect(freeModelsStartHint({ provider: [], provider_next: { all: [model("shared")] } })).toBe(
    "Sign in with vector login for a shared allowance, or use /connect to choose OpenRouter.",
  )
  // A connected provider needs no hint.
  expect(freeModelsStartHint({ provider: [{}], provider_next: { all: [model("shared")] } })).toBeUndefined()
})
