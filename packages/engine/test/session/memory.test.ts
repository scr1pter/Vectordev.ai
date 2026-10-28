import { expect, test } from "bun:test"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { Computer } from "@vectordevai/schema/computer"
import { SessionMemory } from "@/session/memory"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_computer_memory")
const messageID = MessageID.make("msg_computer_memory")

function history(tool: string): SessionV1.WithParts[] {
  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.make("msg_computer_user"),
        agent: "build",
        mode: "build",
        path: { cwd: "/project", root: "/project" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: 0 },
      },
      parts: [
        {
          id: PartID.make("prt_computer_memory"),
          sessionID,
          messageID,
          type: "tool",
          tool,
          callID: "call_computer_memory",
          state: {
            status: "completed",
            input: { action: "read_ui" },
            output: "App controls and text",
            title: "Read app controls",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      ],
    },
  ]
}

test("a completed computer part taints the session as web (INV-S11)", () => {
  expect(SessionMemory.taint(history("read"))).toBeUndefined()
  expect(SessionMemory.taint(history("computer"))).toBe("web")
  expect(SessionMemory.taint([...history("computer"), ...history("read")])).toBe("web")
})

test("admission preserves a computer mention as a hint while stripping engine memory claims", () => {
  const marker = { kind: "feature" }
  expect(
    SessionMemory.admitted({
      [Computer.MENTION_KEY]: marker,
      [SessionMemory.RECALL]: { ids: ["claimed"] },
      [SessionMemory.KNOWLEDGE]: { document: "claimed" },
      [SessionMemory.PERSONAL]: ["claimed"],
    }),
  ).toEqual({ [Computer.MENTION_KEY]: marker })
})
