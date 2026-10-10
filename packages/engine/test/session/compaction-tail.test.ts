import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Token } from "@vectordevai/core/util/token"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderTest } from "../fake/provider"
import type { Provider } from "../../src/provider/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const model = ProviderTest.model()
const sessionID = SessionID.make("ses_compaction_tail")

function message(index: number, text = "x".repeat(400)): SessionV1.WithParts {
  const id = MessageID.make(`msg_tail_${index}`)
  return {
    info: {
      id,
      sessionID,
      parentID: MessageID.make("msg_tail_parent"),
      role: "assistant",
      time: { created: index },
      providerID: model.providerID,
      modelID: model.id,
      agent: "build",
      mode: "build",
      path: { cwd: "/project", root: "/project" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: PartID.make(`prt_tail_${index}`), messageID: id, sessionID, type: "text", text }],
  }
}

const estimate = Effect.fnUntraced(function* (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) {
  return Token.estimate(JSON.stringify(yield* MessageV2.toModelMessagesEffect(input.messages, input.model)))
})

describe("compaction tail selection", () => {
  it.effect("retains the earliest exact-budget suffix with logarithmic conversions", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 128 }, (_, index) => message(index))
      const input = { messages, model, turn: { start: 0, end: messages.length, id: messages[0]!.info.id }, budget: 0 }
      const budget = yield* estimate({ ...input, messages: messages.slice(120) })
      const converted = new Array<number>()
      const selected = yield* SessionCompaction.splitTurn({
        ...input,
        budget,
        estimate: (suffix) => {
          converted.push(suffix.messages.length)
          return estimate(suffix)
        },
      })
      expect(selected).toEqual({ start: 120, id: messages[120]!.info.id })
      expect(converted.length).toBeLessThanOrEqual(8)
      expect(converted.reduce((sum, count) => sum + count, 0)).toBeLessThan(384)
    }),
  )

  it.effect("keeps empty and skipped messages at the first fitting plateau within the turn", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 7 }, (_, index) => message(index))
      messages[2]!.parts = []
      if (messages[3]!.info.role === "assistant")
        messages[3]!.info.error = { name: "UnknownError", data: { message: "failed" } }
      messages[4]!.parts = [{ ...messages[4]!.parts[0]!, type: "step-start" }]
      const input = { messages, model, turn: { start: 0, end: 6, id: messages[0]!.info.id }, budget: 0 }
      const budget = yield* estimate({ ...input, messages: messages.slice(5, 6) })
      expect(
        yield* SessionCompaction.splitTurn({
          ...input,
          budget,
          estimate,
        }),
      ).toEqual({ start: 2, id: messages[2]!.info.id })
    }),
  )

  it.effect("returns no suffix when the budget cannot hold one and respects a nonzero turn start", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 5 }, (_, index) => message(index))
      const input = { messages, model, turn: { start: 2, end: 5, id: messages[2]!.info.id }, budget: 0 }
      for (const budget of [0, 1])
        expect(
          yield* SessionCompaction.splitTurn({
            ...input,
            budget,
            estimate,
          }),
        ).toBeUndefined()
      const converted = new Array<number>()
      expect(
        yield* SessionCompaction.splitTurn({
          ...input,
          budget: 100_000,
          estimate: (suffix) => {
            converted.push(suffix.messages.length)
            return estimate(suffix)
          },
        }),
      ).toEqual({
        start: 3,
        id: messages[3]!.info.id,
      })
      expect(converted).toEqual([2])
      const budget = yield* estimate({ ...input, messages: messages.slice(4) })
      expect(
        yield* SessionCompaction.splitTurn({
          ...input,
          budget,
          estimate,
        }),
      ).toEqual({ start: 4, id: messages[4]!.info.id })
    }),
  )

  it.effect("preserves suffix ordering for tools, injected media and signed reasoning", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 6 }, (_, index) => message(index))
      messages[1]!.parts.push({
        id: PartID.make("prt_tail_tool"),
        messageID: messages[1]!.info.id,
        sessionID,
        type: "tool",
        tool: "read",
        callID: "call_tail_media",
        state: {
          status: "completed",
          input: { filePath: "/project/image.png" },
          title: "Image",
          metadata: {},
          output: "image contents",
          time: { start: 0, end: 1 },
          attachments: [
            {
              id: PartID.make("prt_tail_media"),
              messageID: messages[1]!.info.id,
              sessionID,
              type: "file",
              mime: "image/png",
              url: `data:image/png;base64,${"A".repeat(400)}`,
            },
          ],
        },
      })
      messages[2]!.parts = [
        {
          id: PartID.make("prt_tail_reasoning"),
          messageID: messages[2]!.info.id,
          sessionID,
          type: "reasoning",
          text: "reasoning",
          time: { start: 0, end: 1 },
          metadata: { anthropic: { signature: "signed" } },
        },
        {
          id: PartID.make("prt_tail_separator"),
          messageID: messages[2]!.info.id,
          sessionID,
          type: "text",
          text: "",
        },
      ]
      messages[3]!.parts = []
      for (const npm of ["@ai-sdk/openai", "@ai-sdk/openai-compatible", "@ai-sdk/anthropic"]) {
        const selectedModel = { ...model, api: { ...model.api, npm } }
        const converted = yield* Effect.forEach(messages, (_, index) =>
          MessageV2.toModelMessagesEffect(messages.slice(index), selectedModel),
        )
        const sizes = converted.map((items) => Token.estimate(JSON.stringify(items)))
        sizes.slice(1).forEach((size, index) => expect(size).toBeLessThanOrEqual(sizes[index]!))
        for (const budget of sizes.slice(1).flatMap((size) => [size, size - 1])) {
          const expected = sizes.findIndex((size, index) => index > 0 && size <= budget)
          const input = {
            messages,
            model: selectedModel,
            turn: { start: 0, end: messages.length, id: messages[0]!.info.id },
            budget,
          }
          const selected = yield* SessionCompaction.splitTurn({
            ...input,
            estimate,
          })
          expect(selected?.start).toBe(expected < 0 ? undefined : expected)
        }
      }
    }),
  )
})
