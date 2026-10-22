import { describe, expect, test } from "bun:test"
import { FREE_MODEL_TRAINING_OWNER_ONLY } from "@vectordevai/core/free-model-choice"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import {
  FREE_MODEL_TRAINING_QUESTION,
  acceptFreeModelTraining,
  freeModelTrainingGate,
} from "./free-model-policy-notice"

describe("may-train consent gate", () => {
  const mayTrain = { freeModel: { source: "shared" as const, dataPolicy: "may-train" as const } }
  const calls: string[] = []
  const gate = (input: { consent: boolean | Error; ask: boolean; accept: boolean | Error }) =>
    freeModelTrainingGate({
      model: mayTrain,
      consent: async () => {
        calls.push("consent")
        if (input.consent instanceof Error) throw input.consent
        return input.consent
      },
      ask: async () => {
        calls.push("ask")
        return input.ask
      },
      accept: async () => {
        calls.push("accept")
        if (input.accept instanceof Error) throw input.accept
        return input.accept
      },
    })

  test("no-training and paid models are never asked about", async () => {
    calls.length = 0
    for (const model of [{ freeModel: { source: "shared" as const, dataPolicy: "no-training" as const } }, {}])
      expect(
        await freeModelTrainingGate({
          model,
          consent: async () => false,
          ask: async () => false,
          accept: async () => false,
        }),
      ).toBe(true)
  })

  test("an earlier acceptance lets the prompt go without asking", async () => {
    calls.length = 0
    expect(await gate({ consent: true, ask: false, accept: false })).toBe(true)
    expect(calls).toEqual(["consent"])
  })

  test("the user is asked once, and only a recorded acceptance sends the prompt", async () => {
    calls.length = 0
    expect(await gate({ consent: false, ask: true, accept: true })).toBe(true)
    expect(calls).toEqual(["consent", "ask", "accept"])
    expect(await gate({ consent: false, ask: false, accept: true })).toBe(false)
    expect(await gate({ consent: false, ask: true, accept: false })).toBe(false)
    expect(await gate({ consent: false, ask: true, accept: new Error("engine offline") })).toBe(false)
    // An unreadable acceptance asks again rather than sending.
    calls.length = 0
    expect(await gate({ consent: new Error("engine offline"), ask: false, accept: true })).toBe(false)
    expect(calls).toEqual(["consent", "ask"])
  })

  test("the question, the one place that explains the label, says what the provider may do and that Vector itself never trains", () => {
    expect(FREE_MODEL_TRAINING_QUESTION.title).toBe("May train on your prompts")
    expect(FREE_MODEL_TRAINING_QUESTION.description).toContain(
      "may log your prompts, code and outputs and use them to train its models",
    )
    expect(FREE_MODEL_TRAINING_QUESTION.description).toContain("Vector itself never trains on your prompts.")
    expect(FREE_MODEL_TRAINING_QUESTION.description).not.toMatch(/openrouter/i)
  })

  test("the question names one model but says the acceptance covers every labelled model, reviewed or not", () => {
    // The dialog shows the selected model's name, while one acceptance lets every labelled model, including unreviewed
    // ones and the free router, receive prompts until it is withdrawn.
    const description = FREE_MODEL_TRAINING_QUESTION.description
    expect(description).toContain('Accepting covers every free model labelled "May train on your prompts"')
    expect(description).toContain("including ones Vector has not reviewed yet")
    expect(description).toContain("vector models --decline-training")
  })
})

describe("recording the acceptance", () => {
  // The app's directory client throws on an error status (context/server-sdk.tsx), so the refusal must still say why.
  const engine = (answer: () => Promise<Response>) =>
    createVectorClient({ baseUrl: "http://engine.test", throwOnError: true, fetch: answer }).provider.freeModels
  const record = async (answer: () => Promise<Response>) => {
    const shown: string[] = []
    const accepted = await acceptFreeModelTraining(engine(answer), (description) => shown.push(description))
    return { accepted, shown }
  }

  test("an invited guest's refusal says only the owner can accept, and nothing is sent", async () => {
    expect(
      await record(async () =>
        Response.json({ _tag: "ForbiddenError", message: "This operation requires the server owner" }, { status: 403 }),
      ),
    ).toEqual({ accepted: false, shown: [FREE_MODEL_TRAINING_OWNER_ONLY] })
  })

  test("any other failure, or no answer, asks to try again", async () => {
    const again = { accepted: false, shown: ["Vector couldn't record your choice. Try again."] }
    expect(await record(async () => Response.json({ message: "boom" }, { status: 500 }))).toEqual(again)
    expect(
      await record(async () => {
        throw new TypeError("fetch failed")
      }),
    ).toEqual(again)
    expect(await record(async () => Response.json({ training: false }))).toEqual(again)
  })

  test("a recorded acceptance lets the prompt go without a notice", async () => {
    expect(await record(async () => Response.json({ training: true }))).toEqual({ accepted: true, shown: [] })
  })
})
