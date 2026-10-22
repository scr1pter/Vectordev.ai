import { describe, expect, test } from "bun:test"
import { FREE_MODEL_TRAINING_LABEL } from "@vectordevai/core/free-model-choice"
import { promptTrainingLabel } from "../../src/prompt/training-label"

describe("the label under the prompt for a free model that may train", () => {
  const providers: Parameters<typeof promptTrainingLabel>[0]["providers"] = [
    {
      id: "vector",
      models: {
        "maker/coder:free": { freeModel: { source: "shared", dataPolicy: "may-train" } },
        "maker/quiet:free": { freeModel: { source: "shared", dataPolicy: "no-training" } },
        "openrouter/free": { freeModel: { source: "shared", dataPolicy: "unreviewed" } },
      },
    },
    { id: "anthropic", models: { "claude-sonnet": {} } },
  ]
  const label = (providerID: string, modelID: string, mode: "normal" | "shell" = "normal") =>
    promptTrainingLabel({ mode, providers, current: { providerID, modelID } })

  test("is the label alone, with no disclaimer, for a model that may train or is unreviewed", () => {
    expect(label("vector", "maker/coder:free")).toBe(FREE_MODEL_TRAINING_LABEL)
    expect(label("vector", "openrouter/free")).toBe("May train on your prompts")
  })

  test("is absent in shell mode, for no-training, paid or unlisted models, and with no model chosen", () => {
    expect(label("vector", "maker/coder:free", "shell")).toBeUndefined()
    expect(label("vector", "maker/quiet:free")).toBeUndefined()
    expect(label("anthropic", "claude-sonnet")).toBeUndefined()
    expect(label("vector", "maker/gone:free")).toBeUndefined()
    expect(promptTrainingLabel({ mode: "normal", providers, current: undefined })).toBeUndefined()
  })
})
