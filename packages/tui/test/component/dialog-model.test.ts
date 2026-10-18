import { describe, expect, test } from "bun:test"
import { FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { confirmFreeModelChoice } from "../../src/component/dialog-model"

describe("choosing a free model that may train in the TUI", () => {
  const mayTrain = { freeModel: { source: "openrouter" as const, dataPolicy: "may-train" as const } }
  const run = (input: {
    model?: Parameters<typeof confirmFreeModelChoice>[0]["model"]
    consent?: boolean
    answer?: boolean
    recorded?: { training: boolean } | undefined
    status?: number
  }) => {
    const calls: string[] = []
    const asked: string[] = []
    const notices: string[] = []
    const result = confirmFreeModelChoice({
      model: input.model ?? mayTrain,
      freeModels: {
        consent: async () => {
          calls.push("consent")
          return { data: { training: input.consent ?? false } }
        },
        setConsent: async (body: { freeModelConsent: { training: boolean } }) => {
          calls.push(`setConsent:${body.freeModelConsent.training}`)
          return { data: input.recorded, response: new Response(null, { status: input.status ?? 200 }) }
        },
      } as never,
      ask: async (title, message) => {
        calls.push("ask")
        asked.push(`${title}: ${message}`)
        return input.answer ?? false
      },
      notify: (message) => void notices.push(message),
    })
    return result.then((allowed) => ({ allowed, calls, asked, notices }))
  }

  test("no-training and paid models are chosen without a question", async () => {
    for (const model of [{ freeModel: { source: "openrouter" as const, dataPolicy: "no-training" as const } }, {}])
      expect(await run({ model })).toEqual({ allowed: true, calls: [], asked: [], notices: [] })
  })

  test("an earlier acceptance lets the model be chosen at once", async () => {
    expect(await run({ consent: true })).toMatchObject({ allowed: true, calls: ["consent"] })
  })

  test("the user is asked with the label, the disclaimer and what the acceptance covers, and only a recorded yes chooses it", async () => {
    const accepted = await run({ answer: true, recorded: { training: true } })
    expect(accepted).toMatchObject({ allowed: true, calls: ["consent", "ask", "setConsent:true"], notices: [] })
    expect(accepted.asked[0]).toStartWith("May train on your prompts: ")
    expect(accepted.asked[0]).toContain("Vector itself never trains on your prompts")
    expect(accepted.asked[0]).toContain('Accepting covers every free model labelled "May train on your prompts"')
    // Declining keeps the current model and records nothing.
    expect(await run({ answer: false })).toMatchObject({ allowed: false, calls: ["consent", "ask"] })
    // An unreviewed model is asked about the same way.
    const unreviewed = await run({ model: { freeModel: { source: "openrouter", dataPolicy: "unreviewed" } } })
    expect(unreviewed.asked[0]).toContain("has not reviewed")
  })

  test("an invited guest, whose acceptance the engine refuses, is told only the owner can use these models", async () => {
    const guest = await run({ answer: true, recorded: undefined, status: 403 })
    expect(guest).toMatchObject({ allowed: false, notices: [FREE_MODEL_TRAINING_OWNER_ONLY] })
    const failed = await run({ answer: true, recorded: undefined, status: 500 })
    expect(failed.notices[0]).toContain("Try again")
  })
})
