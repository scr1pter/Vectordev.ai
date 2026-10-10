import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, Session, ToolPart, VectorClient } from "@vectordevai/sdk/v2/client"
import type { retry } from "@vectordevai/core/util/retry"
import { createServerSession } from "../../context/server-session"
import { buildTaskCards, freshestSession, idleLiveSessions } from "./subagent-model"

/*
 * A background subagent finishes while the app's event stream is down. Nothing replays what was missed, so the
 * cached root history, child record and child messages keep saying "running". These tests drive the real session
 * store against an engine that has moved on, and build the Background tasks cards from what the store holds.
 */

const ROOT = "ses_root"
const CHILD = "ses_child"

const retryImmediately: typeof retry = (task) => task()

function session(id: string, updated: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/repo",
    title: id,
    version: "1",
    time: { created: 1, updated },
    ...extra,
  }
}

function record(extra: Record<string, unknown>) {
  return {
    kind: "specialist",
    agent: "explore",
    custom: false,
    title: "Map the auth flow",
    parentSessionID: ROOT,
    parentMessageID: "msg_a1",
    callID: "call_1",
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
    background: true,
    startedAt: 1_000,
    ...extra,
  }
}

function assistant(id: string, sessionID: string, parentID: string, time: AssistantMessage["time"]): AssistantMessage {
  return {
    id,
    sessionID,
    role: "assistant",
    parentID,
    time,
    modelID: "claude-opus-5",
    providerID: "anthropic",
    mode: "build",
    agent: "build",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function user(id: string, sessionID: string): Message {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
  }
}

function launch(metadata: Record<string, unknown>): ToolPart {
  return {
    id: "prt_1",
    sessionID: ROOT,
    messageID: "msg_a1",
    type: "tool",
    callID: "call_1",
    tool: "task",
    state: {
      status: "completed",
      input: { description: "Map the auth flow", prompt: "Map it", subagent_type: "explore" },
      output: "",
      title: "",
      metadata,
      time: { start: 1_000, end: 1_100 },
    },
  }
}

// The engine as the stream left it: the subagent launched in the background and was working.
function engine() {
  const sessions = new Map<string, Session>([
    [ROOT, session(ROOT, 1_100)],
    [CHILD, session(CHILD, 1_000, { parentID: ROOT, metadata: { subagent: record({ status: "running" }) } })],
  ])
  const messages = new Map<string, { info: Message; parts: Part[] }[]>([
    [
      ROOT,
      [
        { info: user("msg_u1", ROOT), parts: [] },
        {
          info: assistant("msg_a1", ROOT, "msg_u1", { created: 900, completed: 1_100 }),
          parts: [launch({ sessionId: CHILD, status: "running", background: true, startedAt: 1_000 })],
        },
      ],
    ],
    [
      CHILD,
      [
        { info: user("msg_cu", CHILD), parts: [] },
        { info: assistant("msg_ca", CHILD, "msg_cu", { created: 2_000 }), parts: [] },
      ],
    ],
  ])
  const client = {
    session: {
      get: async (input: { sessionID: string }) => ({ data: structuredClone(sessions.get(input.sessionID)) }),
      messages: async (input: { sessionID: string }) => ({
        data: structuredClone(messages.get(input.sessionID) ?? []),
        response: { headers: new Headers() },
      }),
      children: async (input: { sessionID: string }) => ({
        data: structuredClone([...sessions.values()].filter((item) => item.parentID === input.sessionID)),
      }),
    },
  }
  return {
    client,
    // What happened while the stream was down: the child finished, its record settled and so did the task part.
    finish(options: { part: boolean }) {
      const done = { status: "completed", completedAt: 9_000 }
      sessions.set(
        CHILD,
        session(CHILD, 9_000, { parentID: ROOT, metadata: { subagent: record({ ...done }) } }),
      )
      messages.set(CHILD, [
        { info: user("msg_cu", CHILD), parts: [] },
        { info: assistant("msg_ca", CHILD, "msg_cu", { created: 2_000, completed: 9_000 }), parts: [] },
      ])
      if (!options.part) return
      messages.set(ROOT, [
        messages.get(ROOT)![0]!,
        {
          info: assistant("msg_a1", ROOT, "msg_u1", { created: 900, completed: 1_100 }),
          parts: [launch({ sessionId: CHILD, background: true, startedAt: 1_000, ...done })],
        },
      ])
    },
  }
}

function cards(store: ReturnType<typeof createServerSession>, fetched: readonly Session[] = []) {
  const byID = new Map(fetched.map((item) => [item.id, item]))
  return buildTaskCards({
    rootID: ROOT,
    messages: (id) => store.data.message[id],
    parts: (id) => store.data.part[id],
    session: (id) => freshestSession(store.get(id), byID.get(id)),
    children: [CHILD].flatMap((id) => {
      const found = freshestSession(store.get(id), byID.get(id))
      return found ? [found] : []
    }),
    status: (id) => store.data.session_status[id],
  })
}

async function stale(fake: ReturnType<typeof engine>) {
  const store = createServerSession(fake.client as unknown as VectorClient, { retry: retryImmediately })
  await store.sync(ROOT)
  await store.sync(CHILD)
  expect(cards(store)[0]!.agents[0]!.status).toBe("running")
  return store
}

describe("a card the event stream left running", () => {
  test("stays running through a cached reload, and settles once the reconnect forces a fresh copy", async () => {
    const fake = engine()
    const store = await stale(fake)
    fake.finish({ part: true })

    // The old settle path: messages were cached, so a plain sync did nothing.
    await store.sync(CHILD)
    expect(cards(store)[0]!.agents[0]!.status).toBe("running")

    // The child is idle by session_status, so it is reloaded although its messages are cached.
    const agents = cards(store)[0]!.agents
    expect(idleLiveSessions(agents, (id) => store.data.session_status[id]?.type)).toEqual([CHILD])
    await Promise.all([ROOT, CHILD].map((id) => store.sync(id, { force: true })))

    const card = cards(store)[0]!
    expect(card.live).toBe(false)
    expect(card.agents[0]!.status).toBe("done")
    expect(card.agents[0]!.endedAt).toBe(9_000)
  })

  test("settles from the child alone when the task part never received the outcome", async () => {
    const fake = engine()
    const store = await stale(fake)
    fake.finish({ part: false })

    await store.sync(CHILD, { force: true })

    expect(cards(store)[0]!.agents[0]!.status).toBe("done")
  })

  test("settles from the refetched children route when nothing else reloads the child", async () => {
    const fake = engine()
    const store = await stale(fake)
    fake.finish({ part: false })

    const fetched = (await fake.client.session.children({ sessionID: ROOT })).data
    expect(store.get(CHILD)?.time.updated).toBe(1_000)

    const card = cards(store, fetched)[0]!
    expect(card.live).toBe(false)
    expect(card.agents[0]!.endedAt).toBe(9_000)
  })

  test("a live event newer than the children route still wins", async () => {
    const fake = engine()
    const store = await stale(fake)
    const fetched = (await fake.client.session.children({ sessionID: ROOT })).data
    fake.finish({ part: false })
    await store.sync(CHILD, { force: true })

    expect(cards(store, fetched)[0]!.agents[0]!.status).toBe("done")
  })
})
