import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionTaskSize } from "../../src/session/task-size"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

// The history fold on its own: which request a message belongs to, and what size each request is sent at.

const sessionID = SessionID.make("ses_task-size-history")
const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") }
let clock = 1_000

function user(text: string, extra: { synthetic?: boolean; judge?: SessionV1.User["judge"]; at?: number } = {}) {
  const id = MessageID.ascending()
  clock = extra.at ?? clock + 1_000
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: clock },
      agent: "build",
      model,
      ...(extra.judge ? { judge: extra.judge } : {}),
    },
    parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text, synthetic: extra.synthetic }],
  } as SessionV1.WithParts
}

function assistant(text: string, finish = "stop", tools: { tool: string; metadata?: Record<string, unknown> }[] = []) {
  const id = MessageID.ascending()
  clock += 1_000
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: id,
      mode: "build",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: model.modelID,
      providerID: model.providerID,
      time: { created: clock, completed: clock },
      finish,
    },
    parts: [
      { id: PartID.ascending(), sessionID, messageID: id, type: "text", text },
      ...tools.map((item) => ({
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "tool",
        callID: "call",
        tool: item.tool,
        state: {
          status: "completed",
          input: {},
          output: "",
          title: "",
          metadata: item.metadata ?? {},
          time: { start: 1, end: 2 },
        },
      })),
    ],
  } as SessionV1.WithParts
}

const size = (messages: SessionV1.WithParts[], caching = false, lifetime = 60_000) =>
  SessionTaskSize.size({ messages, caching, lifetime })

describe("SessionTaskSize.size", () => {
  test("a message sent while the run is going joins its request and can only raise it", () => {
    const requests = size([
      user("fix the typo in README.md"),
      assistant("Reading it.", "tool-calls", [{ tool: "read" }]),
      user("actually, be thorough and check every page"),
      assistant("Done."),
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.users).toHaveLength(2)
    expect(requests[0]?.tier).toBe("thorough")
  })

  test("a completed escalate call raises its request one step, and the next request starts fresh", () => {
    const requests = size([
      user("rename getUser to fetchUser"),
      assistant("This touches every route.", "tool-calls", [
        { tool: "escalate", metadata: { from: "light", to: "standard" } },
      ]),
      assistant("Renamed."),
      user("thanks"),
      assistant("You're welcome!"),
    ])
    expect(requests.map((request) => request.tier)).toEqual(["standard", "chat"])
    expect(requests[0]?.escalated).toBe(true)
  })

  test("a continue after a thanks exchange continues the work, not the thanks", () => {
    const requests = size([
      user("add OAuth login with tests"),
      assistant("Added login."),
      user("thanks"),
      assistant("Anytime!"),
      user("continue"),
    ])
    expect(requests.map((request) => request.tier)).toEqual(["standard", "chat", "standard"])
    // The cloud cue ("login") comes along with the size.
    expect(requests[2]?.offered.cloud).toBe(true)
  })

  test("Vector's own follow-ups continue the request they belong to", () => {
    const requests = size([
      user("migrate the app to the new router across 40 files"),
      assistant("Migrated."),
      user("<vector_judge_verdict>FAIL</vector_judge_verdict>", { synthetic: true }),
      assistant("Repaired."),
    ])
    expect(requests).toHaveLength(1)
    expect(requests[0]?.messages).toHaveLength(4)
  })

  test("on a caching provider the offered size stays the highest while the cache is warm, and resets once cold", () => {
    const warm = size(
      [
        user("migrate the app to the new router across 40 files"),
        assistant("Done."),
        user("fix the typo in README.md"),
      ],
      true,
    )
    expect(warm.map((request) => [request.tier, request.offered.tier])).toEqual([
      ["thorough", "thorough"],
      ["light", "thorough"],
    ])
    const later = clock + 10 * 60_000
    const cold = size(
      [
        user("migrate the app to the new router across 40 files"),
        assistant("Done."),
        user("fix the typo in README.md", { at: later }),
      ],
      true,
    )
    expect(cold[1]?.offered.tier).toBe("light")
    // A model without caching always follows the request's own size.
    const free = size([
      user("migrate the app to the new router across 40 files"),
      assistant("Done."),
      user("fix the typo"),
    ])
    expect(free[1]?.offered.tier).toBe("light")
  })

  test("the judge setting comes from the prompt, else an older client's policy, else the config", () => {
    expect(size([user("migrate everything", { judge: "changes" })])[0]?.judge).toBe("changes")
    const legacy = user("migrate everything")
    legacy.parts.push({
      id: PartID.ascending(),
      sessionID,
      messageID: legacy.info.id,
      type: "text",
      text: "<vector_verified_completion>LLM-as-a-judge is enabled.",
      synthetic: true,
    })
    expect(size([legacy])[0]?.judge).toBe("thorough")
    expect(
      SessionTaskSize.size({ messages: [user("migrate everything")], caching: false, lifetime: 0, judge: "changes" })[0]
        ?.judge,
    ).toBe("changes")
    expect(size([user("migrate everything")])[0]?.judge).toBe("off")
    // "Skip the judge" in the message wins for that request.
    expect(size([user("be thorough but skip the judge", { judge: "thorough" })])[0]?.judge).toBe("off")
  })

  test("changed files come from patches and completed edits after the last verdict", () => {
    // Message IDs are ordered, so the user's message is made first.
    const ask = user("migrate the router across 40 files")
    const edit = assistant("Edited.", "tool-calls", [{ tool: "edit" }])
    const editPart = edit.parts.find((part) => part.type === "tool")
    if (editPart?.type === "tool" && editPart.state.status === "completed")
      editPart.state.input = { filePath: "/r/a.ts" }
    const request = size([ask, edit, assistant("Done.")])[0]!
    expect(SessionTaskSize.changedFiles(request)).toEqual(["/r/a.ts"])
    expect(SessionTaskSize.changedFiles(request, request.messages.at(-1)?.info.id)).toEqual([])
  })
})
