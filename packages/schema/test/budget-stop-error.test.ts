import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionV1 } from "../src/v1/session"

const assistant = {
  id: "msg_budget",
  sessionID: "ses_budget",
  role: "assistant",
  time: { created: 1, completed: 2 },
  parentID: "msg_user",
  modelID: "model",
  providerID: "provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 5.02,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
}

test("an assistant message stopped by the spend guard decodes with its BudgetStopError", () => {
  const error = {
    name: "BudgetStopError",
    data: {
      reason: "predicted",
      message:
        "Stopped before the next step: $4.62 spent of a $5.00 cap, and the next step was estimated at $0.41–$0.97 at catalog list prices.",
      spentUsd: 4.62,
      capUsd: 5,
      unpricedSteps: 0,
      estimate: { lowUsd: 0.41, highUsd: 0.97 },
    },
  }
  expect(Schema.decodeUnknownSync(SessionV1.Info)({ ...assistant, error })).toMatchObject({ error })
  expect(
    Schema.decodeUnknownSync(SessionV1.Assistant)({
      ...assistant,
      error: { name: "BudgetStopError", data: { reason: "loop", message: "Paused a repeating loop." } },
    }).error,
  ).toEqual({ name: "BudgetStopError", data: { reason: "loop", message: "Paused a repeating loop." } })
  expect(() =>
    Schema.decodeUnknownSync(SessionV1.Assistant)({
      ...assistant,
      error: { name: "BudgetStopError", data: { reason: "overdraft", message: "x" } },
    }),
  ).toThrow()
})
