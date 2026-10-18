import { describe, expect, test } from "bun:test"
import {
  FREE_MODEL_POLICY_NOTICE,
  firstFreeModelPolicyNotice,
  freeModelTrainingGate,
  freeModelTrainingNotice,
} from "./free-model-policy-notice"

describe("free model policy notice", () => {
  test("shows once per device", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    }
    expect(firstFreeModelPolicyNotice(() => storage)).toBe(true)
    expect(firstFreeModelPolicyNotice(() => storage)).toBe(false)
  })

  test("still shows when storage refuses access", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => undefined,
    }
    expect(firstFreeModelPolicyNotice(() => storage)).toBe(true)
    expect(firstFreeModelPolicyNotice(() => undefined)).toBe(true)
  })

  test("says the providers are not zero data retention and that may-train models ask first", () => {
    expect(FREE_MODEL_POLICY_NOTICE.title).toBe("How Free models inside of Vector handle your data")
    expect(FREE_MODEL_POLICY_NOTICE.description).toContain("Not zero data retention")
    expect(FREE_MODEL_POLICY_NOTICE.description).toContain('"May train on your prompts" ask before your first prompt')
  })
})

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

  test("the notice says what the provider may do and that Vector itself never trains", () => {
    const notice = freeModelTrainingNotice(mayTrain)
    expect(notice.title).toBe("May train on your prompts")
    expect(notice.description).toContain("may log your prompts, code and outputs and use them to train its models")
    expect(notice.description).toContain("Vector itself never trains on your prompts.")
    expect(
      freeModelTrainingNotice({ freeModel: { source: "openrouter", dataPolicy: "unreviewed" } }).description,
    ).toContain("has not reviewed")
  })

  test("the question names one model but says the acceptance covers every labelled model, reviewed or not", () => {
    // The dialog shows the selected model's name, while one acceptance lets every labelled model, including unreviewed
    // ones whose disclaimer the user never saw, receive prompts until it is withdrawn.
    for (const dataPolicy of ["may-train", "unreviewed"] as const) {
      const description = freeModelTrainingNotice({ freeModel: { source: "openrouter", dataPolicy } }).description
      expect(description).toContain('Accepting covers every free model labelled "May train on your prompts"')
      expect(description).toContain("including ones Vector has not reviewed yet")
      expect(description).toContain("vector models --decline-training")
    }
  })
})
