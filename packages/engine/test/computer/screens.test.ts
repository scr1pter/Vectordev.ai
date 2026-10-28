import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { ComputerScreens } from "@/computer/screens"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.make("ses_screens")
const messageID = MessageID.make("msg_screens")

function screen(index: number, tool = "computer", mime = "image/png"): SessionV1.ToolPart {
  return {
    id: PartID.make(`prt_${index}`),
    sessionID,
    messageID,
    type: "tool",
    tool,
    callID: `call_${index}`,
    state: {
      status: "completed",
      input: { action: "screenshot" },
      output: `Screenshot ${index}`,
      title: "Observe app",
      time: { start: index, end: index + 1 },
      metadata: { frame: { id: `frame_${index}` } },
      attachments: [
        {
          id: PartID.make(`prt_image_${index}`),
          sessionID,
          messageID,
          type: "file",
          mime,
          url: `data:${mime};base64,c2NyZWVu`,
        },
      ],
    },
  }
}

function history(parts: SessionV1.Part[]): SessionV1.WithParts[] {
  return [
    {
      info: {
        id: messageID,
        sessionID,
        role: "assistant",
        parentID: MessageID.make("msg_user"),
        time: { created: 0 },
        agent: "build",
        mode: "build",
        modelID: ModelV2.ID.make("test"),
        providerID: ProviderV2.ID.make("test"),
        path: { cwd: "/project", root: "/project" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts,
    },
  ]
}

describe("computer screenshot history", () => {
  test("keeps the newest three screenshots when each older image can be pruned", () => {
    const input = history(Array.from({ length: 6 }, (_, index) => screen(index)))
    const saved = JSON.stringify(input)
    expect([...ComputerScreens.keep(input, { keep: 3, batch: 1 })]).toEqual(["prt_0", "prt_1", "prt_2"])
    expect(JSON.stringify(input)).toBe(saved)
    expect([...ComputerScreens.keep(history([screen(0), screen(1)]), { keep: 3, batch: 1 })]).toEqual([])
  })

  test("a small context keeps two with no batching", () => {
    expect([...ComputerScreens.keep(history([screen(0), screen(1), screen(2)]), { keep: 2, batch: 1 })]).toEqual([
      "prt_0",
    ])
  })

  test("cache pruning advances only in complete blocks of 25", () => {
    for (const [count, dropped] of [
      [27, 0],
      [28, 25],
      [52, 25],
      [53, 50],
    ]) {
      const result = ComputerScreens.keep(history(Array.from({ length: count }, (_, index) => screen(index))), {
        keep: 3,
        batch: 25,
      })
      expect([...result]).toEqual(Array.from({ length: dropped }, (_, index) => `prt_${index}`))
      expect(result.has(`prt_${count - 1}`)).toBe(false)
    }
  })

  test("a cached prefix stays identical until the next complete pruning block", () => {
    const parts = Array.from({ length: 52 }, (_, index) => screen(index))
    const first = ComputerScreens.keep(history(parts.slice(0, 28)), { keep: 3, batch: 25 })
    expect(ComputerScreens.keep(history(parts), { keep: 3, batch: 25 })).toEqual(first)
  })

  test("only completed computer images count, preserving other media and tools", () => {
    const parts: SessionV1.Part[] = [
      screen(0),
      screen(1, "browser"),
      screen(2, "read"),
      screen(3, "computer", "application/pdf"),
      {
        id: PartID.make("prt_file"),
        sessionID,
        messageID,
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,dXNlcg==",
      },
      { ...screen(4), state: { status: "error", input: {}, error: "Capture failed", time: { start: 0, end: 1 } } },
      { ...screen(5), state: { status: "running", input: {}, time: { start: 0 } } },
      screen(6),
      screen(7),
      screen(8),
    ]
    const input = history(parts)
    const saved = JSON.stringify(input)
    expect([...ComputerScreens.keep(input, { keep: 3, batch: 1 })]).toEqual(["prt_0"])
    expect(JSON.stringify(input)).toBe(saved)
  })

  test("history order across assistant messages determines the newest frames", () => {
    const input = [...history([screen(0), screen(1)]), ...history([screen(2), screen(3)]), ...history([screen(4)])]
    expect([...ComputerScreens.keep(input, { keep: 3, batch: 1 })]).toEqual(["prt_0", "prt_1"])
  })
})
