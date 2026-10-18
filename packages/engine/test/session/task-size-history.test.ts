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

function user(
  text: string,
  extra: { synthetic?: boolean; judge?: SessionV1.User["judge"]; at?: number; agent?: string } = {},
) {
  const id = MessageID.ascending()
  clock = extra.at ?? clock + 1_000
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: clock },
      agent: extra.agent ?? "build",
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

// A reply that wrote a file, as a completed write call.
function wrote(file: string, text = "Wrote it.", finish = "tool-calls") {
  const message = assistant(text, finish, [{ tool: "write" }])
  const part = message.parts.find((item) => item.type === "tool")
  if (part?.type === "tool" && part.state.status === "completed") part.state.input = { filePath: file }
  return message
}

// Vector's judge run, as the task card it records on an assistant message.
function judgedBy(verdict: string, workSize?: string) {
  const message = assistant(`VERDICT: ${verdict}`, verdict === "FAIL" ? "tool-calls" : "stop", [{ tool: "task" }])
  const part = message.parts.find((item) => item.type === "tool")
  if (part?.type === "tool") part.metadata = { judge: { round: 1, verdict, ...(workSize ? { size: workSize } : {}) } }
  return message
}

// The compaction marker a summary answers, with what the runner recorded of the request it summarised.
function marker(carried?: SessionTaskSize.Carried) {
  const message = user("")
  message.parts = [
    { id: PartID.ascending(), sessionID, messageID: message.info.id, type: "compaction", auto: true },
    ...(carried
      ? [
          {
            id: PartID.ascending(),
            sessionID,
            messageID: message.info.id,
            type: "text" as const,
            text: "recorded",
            synthetic: true,
            ignored: true,
            metadata: { [SessionTaskSize.CARRIED]: carried },
          },
        ]
      : []),
  ]
  return message
}

function recorded(part: SessionV1.Part): SessionTaskSize.Carried[] {
  return part.type === "text" && part.metadata?.[SessionTaskSize.CARRIED]
    ? [part.metadata[SessionTaskSize.CARRIED]]
    : []
}

function summary(parent: SessionV1.WithParts) {
  const message = assistant("Summary of the work so far.")
  if (message.info.role === "assistant") {
    message.info.summary = true
    message.info.parentID = parent.info.id
  }
  return message
}

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

  test("two raises take a light request to thorough; the highest raise counts", () => {
    const requests = size([
      user("rename getUser to fetchUser"),
      assistant("More than a rename.", "tool-calls", [
        { tool: "escalate", metadata: { from: "light", to: "standard" } },
      ]),
      assistant("It spans every package.", "tool-calls", [
        { tool: "escalate", metadata: { from: "standard", to: "thorough" } },
      ]),
      assistant("Renamed."),
    ])
    expect(requests[0]?.tier).toBe("thorough")
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

  test("a request whose opening a compaction summarised keeps the size, judge and words it recorded", () => {
    // The opening message is out of view; only the marker, its summary and the continue are left.
    const opening = MessageID.ascending()
    const compaction = marker({
      opened: opening,
      tier: "thorough",
      judge: "thorough",
      text: "migrate the app to the new router across 40 files",
      files: ["/r/router.ts"],
      cloud: false,
      browser: false,
      agents: [],
    })
    const messages = [
      compaction,
      summary(compaction),
      user("Continue if you have next steps.", { synthetic: true }),
      assistant("Migrated the router."),
    ]
    const requests = size(messages)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tier).toBe("thorough")
    expect(requests[0]?.judge).toBe("thorough")
    expect(SessionTaskSize.requestText(requests[0]!)).toContain("new router")
    // The judge still sees the work the summary replaced.
    expect(SessionTaskSize.judgeable(requests, opening)?.files).toEqual(["/r/router.ts"])
    // A "continue" afterwards continues that work with its size, never as a bare reply.
    const next = size([...messages, user("continue")])
    expect(next.map((request) => request.tier)).toEqual(["thorough", "thorough"])
    // A message that joined the summarised request in the retained tail stays part of it.
    const start = MessageID.ascending()
    const joined = user("also update the docs")
    const reading = assistant("Updating.", "tool-calls", [{ tool: "read" }])
    const later = marker({ ...compaction.parts.flatMap(recorded)[0]!, opened: start })
    const tail = size([later, summary(later), joined, reading])
    expect(tail).toHaveLength(1)
    expect(tail[0]?.users).toHaveLength(1)
    expect(tail[0]?.tier).toBe("thorough")
  })

  test("a continue after a compaction that recorded nothing is work of unknown size, not a bare reply", () => {
    const compaction = marker()
    const requests = size([compaction, summary(compaction), user("continue")])
    expect(requests.at(-1)?.tier).toBe("standard")
    expect(size([compaction, summary(compaction), user("hi")]).at(-1)?.tier).toBe("chat")
  })

  test("the judge checks every request the run answered, and the work a yes continues", () => {
    const since = MessageID.ascending()
    // A message sent during the final step opens its own request after the large one.
    const joined = size([
      user("migrate the app to the new router across 40 files", { judge: "thorough" }),
      wrote("/r/router.ts"),
      assistant("Migrated the router."),
      user("also fix the typo in README", { judge: "thorough" }),
      assistant("Fixed the typo."),
    ])
    expect(joined.map((request) => request.tier)).toEqual(["thorough", "light"])
    const work = SessionTaskSize.judgeable(joined, since)
    // The judge reads both requests: the large one qualifies the work, and the joined one is part of it.
    expect(work?.requests).toHaveLength(2)
    expect(work?.files).toEqual(["/r/router.ts"])

    // A yes to the agent's question, in a later run, takes the work it answers to the judge.
    const ask = user("migrate the app to the new router across 40 files", { judge: "thorough" })
    const before = [ask, wrote("/r/router.ts"), assistant("Migrated 30 routes. Should I also migrate the tests?")]
    const later = MessageID.ascending()
    const answered = size([...before, user("yes", { judge: "thorough" }), assistant("Migrated the tests.")])
    expect(answered.map((request) => request.tier)).toEqual(["thorough", "thorough"])
    expect(SessionTaskSize.judgeable(answered, later)?.files).toEqual(["/r/router.ts"])
    // A short instruction after the agent asked is part of the same work, so it is judged with it too.
    const instead = size([...before, user("fix the typo in README first", { judge: "thorough" }), assistant("Fixed.")])
    expect(instead.map((request) => request.tier)).toEqual(["thorough", "thorough"])
    expect(SessionTaskSize.judgeable(instead, later)?.requests).toHaveLength(2)
    // A light request after finished work is judged on its own, and in "thorough" mode it is not.
    const done = [ask, wrote("/r/router.ts"), assistant("Migrated all 40 routes.")]
    const next = MessageID.ascending()
    const unrelated = size([...done, user("fix the typo in README", { judge: "thorough" }), assistant("Fixed.")])
    expect(unrelated.map((request) => request.tier)).toEqual(["thorough", "light"])
    expect(SessionTaskSize.judgeable(unrelated, next)).toBeUndefined()
  })

  test("large work that ended on an offer is judged once the user declines it or says thanks", () => {
    const ask = user("migrate the app to the new router across 40 files", { judge: "thorough" })
    const offer = [
      ask,
      wrote("/r/router.ts"),
      assistant("Migrated all 40 routes and the tests pass. Want me to also update the docs?"),
    ]
    for (const text of ["thanks", "no thanks", "no", "ok thanks"]) {
      const after = MessageID.ascending()
      const requests = size([...offer, user(text, { judge: "thorough" }), assistant("You're welcome!")])
      const work = SessionTaskSize.judgeable(requests, after)
      expect(work?.files, text).toEqual(["/r/router.ts"])
      expect(work?.tier, text).toBe("thorough")
      expect(SessionTaskSize.requestText(work!.requests[0]!), text).toContain("new router")
    }
    // A greeting answers nothing, so it never brings in the judge; the work waits for the reply that does.
    const greeted = MessageID.ascending()
    expect(
      SessionTaskSize.judgeable(size([...offer, user("hi", { judge: "thorough" }), assistant("Hi!")]), greeted),
    ).toBeUndefined()
    // Once judged, a later thanks has nothing left to judge.
    const judged = [...offer, user("thanks"), assistant("You're welcome!"), judgedBy("PASS", "thorough")]
    const after = MessageID.ascending()
    const done = size([...judged, user("thanks again"), assistant("Anytime!")])
    expect(SessionTaskSize.judgeable(done, after)).toBeUndefined()
  })

  test("a plain no to an offer settles the work; a no to a real question is an answer inside it", () => {
    const ask = user("migrate the app to the new router across 40 files", { judge: "thorough" })
    const offered = [
      ask,
      wrote("/r/router.ts"),
      assistant("Migrated all 40 routes and the tests pass. Want me to also update the docs?"),
    ]
    for (const text of ["no thanks", "no", "not now", "stop here for now"]) {
      const after = MessageID.ascending()
      const requests = size([...offered, user(text, { judge: "thorough" }), assistant("Okay.")])
      // Nothing is left to do, so the decline is a direct reply, not a full Thorough request.
      expect(requests.at(-1)?.result, text).toMatchObject({ tier: "chat", reasons: ["decline"] })
      const work = SessionTaskSize.judgeable(requests, after)
      expect(work?.tier, text).toBe("thorough")
      // The judge sees the offer and the decline, and the work's own report rather than "Okay.".
      expect(work?.exchanges, text).toEqual([{ asked: expect.stringContaining("update the docs?"), reply: text }])
      expect(work?.report, text).toContain("Migrated all 40 routes")
    }
    // A real question: "no" is the user's answer, so the work goes on at its size, and the judge is told the answer.
    const questioned = [
      ask,
      wrote("/r/router.ts"),
      assistant("Migrated 20 of 40 routes. Should I convert them to the new loader API?"),
    ]
    const later = MessageID.ascending()
    const answered = size([...questioned, user("no", { judge: "thorough" }), wrote("/r/rest.ts"), assistant("Done.")])
    expect(answered.at(-1)?.result).toMatchObject({ tier: "thorough", source: "inherited" })
    const work = SessionTaskSize.judgeable(answered, later)
    expect(work?.exchanges).toEqual([{ asked: expect.stringContaining("new loader API?"), reply: "no" }])
    expect(work?.files).toEqual(["/r/router.ts", "/r/rest.ts"])
  })

  test("a plan that asked nothing is carried out by a build it or the user's own approval, and judged with it", () => {
    for (const text of ["build it", "implement the plan", "looks good, build it", "go with option b", "approved"]) {
      const plan = user("plan how to port the TUI to Rust", { judge: "thorough" })
      const requests = size([
        plan,
        assistant("Here is the plan in three phases: the renderer, the input layer, then the views."),
        user(text, { judge: "thorough" }),
        wrote("/r/tui.rs"),
        assistant("Ported the renderer."),
      ])
      expect(requests.map((request) => [request.tier, request.result.source]), text).toEqual([
        ["thorough", "auto"],
        ["thorough", "inherited"],
      ])
      const work = SessionTaskSize.judgeable(requests, plan.info.id)
      expect(work?.requests.map((request) => SessionTaskSize.requestText(request)), text).toEqual([
        "plan how to port the TUI to Rust",
        text,
      ])
    }
  })

  test("a quick-lane thanks after build work settles it like a thanks on the build agent", () => {
    const after = MessageID.ascending()
    const requests = size([
      user("migrate the app to the new router across 40 files", { judge: "thorough" }),
      wrote("/r/router.ts"),
      assistant("Migrated all 40 routes. Want me to also update the docs?"),
      user("thanks", { judge: "thorough", agent: "quick" }),
      assistant("You're welcome!"),
    ])
    const work = SessionTaskSize.judgeable(requests, after)
    expect(work?.files).toEqual(["/r/router.ts"])
    expect(work?.report).toContain("Migrated all 40 routes")
  })

  test("the judge pairs a question with the user's answer, not a greeting, and a thanks is not part of the request", () => {
    const ask = user("migrate the app to the new router across 40 files", { judge: "thorough" })
    const messages = [
      ask,
      wrote("/r/router.ts"),
      assistant("Migrated 20 of 40 routes. Should I convert the rest to the new loader API?"),
      user("hi", { judge: "thorough" }),
      assistant("Hi!"),
      user("thanks", { judge: "thorough" }),
      assistant("You're welcome!"),
      judgedBy("FAIL", "thorough"),
      user("<vector_judge_verdict>FAIL</vector_judge_verdict>", { synthetic: true }),
      wrote("/r/router.ts"),
      assistant("Repaired the router."),
    ]
    const work = SessionTaskSize.judgeable(size(messages), ask.info.id)
    expect(work?.exchanges).toEqual([{ asked: expect.stringContaining("new loader API?"), reply: "thanks" }])
    // The repair raised the thanks to the work's size, but the user asked only for the migration.
    expect(work?.requests.map((request) => SessionTaskSize.requestText(request))).toEqual([
      "migrate the app to the new router across 40 files",
    ])
    expect(work?.tier).toBe("thorough")
    expect(work?.report).toBe("Repaired the router.")
  })

  test("a judge FAIL raises the request it repairs to the size of the work it judged", () => {
    const requests = size([
      user("migrate the app to the new router across 40 files", { judge: "thorough" }),
      wrote("/r/router.ts"),
      assistant("Migrated all 40 routes. Want me to also update the docs?"),
      user("thanks", { judge: "thorough" }),
      assistant("You're welcome!"),
      judgedBy("FAIL", "thorough"),
      user("<vector_judge_verdict>FAIL</vector_judge_verdict>", { synthetic: true }),
    ])
    expect(requests.map((request) => request.tier)).toEqual(["thorough", "thorough"])
    expect(requests[1]?.result.tier).toBe("chat")
  })

  test("a run that did not finish, or a dismissed question, leaves the work open for the next message", () => {
    const ask = user("migrate the app to the new router across 40 files")
    const interrupted = assistant("Migrating the routes", "tool-calls")
    if (interrupted.info.role === "assistant")
      interrupted.info.error = { name: "MessageAbortedError", data: { message: "Aborted" } }
    const stopped = size([ask, interrupted, user("use the v6 api instead")])
    expect(stopped.map((request) => [request.tier, request.result.source])).toEqual([
      ["thorough", "auto"],
      ["thorough", "inherited"],
    ])
    const cut = size([user("migrate the app to the new router across 40 files"), assistant("Migrated 12 of", "length"), user("ok")])
    expect(cut.at(-1)?.tier).toBe("thorough")
    const asking = user("migrate the app to the new router across 40 files")
    const dismissed = assistant("Which router?", "stop")
    dismissed.parts.push({
      id: PartID.ascending(),
      sessionID,
      messageID: dismissed.info.id,
      type: "tool",
      callID: "question",
      tool: "question",
      state: { status: "error", input: {}, error: "dismissed", time: { start: 1, end: 2 } },
    } as SessionV1.Part)
    const answered = size([asking, dismissed, user("the new one")])
    expect(answered.at(-1)?.tier).toBe("thorough")
    // A finished run leaves nothing open: a plain "ok" afterwards is just a reply.
    const finished = size([user("migrate the app to the new router across 40 files"), assistant("Migrated all 40."), user("ok")])
    expect(finished.at(-1)?.tier).toBe("chat")
  })

  test("a yes to a greeting reply's offer gets the work harness, not the quick lane", () => {
    const requests = size([
      user("hi"),
      assistant("Hi! Should I take a look at the failing tests in this repository?"),
      user("yes"),
    ])
    expect(requests.map((request) => request.tier)).toEqual(["chat", "standard"])
    // A greeting reply's pleasantry offers nothing.
    expect(size([user("hi"), assistant("Hi! How can I help you today?"), user("ok")]).at(-1)?.tier).toBe("chat")
  })

  test("asking for the judge in the message turns it on for that request; a mention does not", () => {
    expect(size([user("migrate the router, then run the judge")])[0]?.judge).toBe("thorough")
    expect(size([user("use llm-as-a-judge on this change", { judge: "changes" })])[0]?.judge).toBe("changes")
    expect(size([user("llm as a judge launches on hi, fix it")])[0]).toMatchObject({ tier: "standard", judge: "off" })
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
