import { expect, test } from "bun:test"
import { createVectorClient, type Event } from "@vectordevai/sdk/v2/client"
import { createSessionEconomics } from "./session-economics"

const directory = "/repo"
const model = { providerID: "openai", modelID: "gpt-6.1" }

// One idle root whose history is read through the real SDK client. `writeDuringHistory` makes the engine write the
// session while its history is being read, as a late title or subagent spend can.
function setup(input: { writeDuringHistory: boolean }) {
  const state = { updated: 10, cost: 0.004, wrote: false }
  const requests: string[] = []
  const history = [
    {
      info: { id: "msg_1", sessionID: "ses_root", role: "user", agent: "build", model, time: { created: 1 } },
      parts: [{ id: "prt_1", sessionID: "ses_root", messageID: "msg_1", type: "text", text: "Fix the login form." }],
    },
    {
      info: {
        id: "msg_2",
        sessionID: "ses_root",
        role: "assistant",
        parentID: "msg_1",
        ...model,
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0.004,
        tokens: { input: 1_200, output: 300, reasoning: 0, cache: { read: 8_000, write: 0 } },
        finish: "stop",
        time: { created: 2, completed: 5 },
      },
      parts: [],
    },
  ]
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (path.endsWith("/message") && input.writeDuringHistory && !state.wrote) {
      state.wrote = true
      state.updated += 1
      state.cost += 0.0003
    }
    const body = path.endsWith("/message")
      ? history
      : {
          id: "ses_root",
          slug: "ses_root",
          projectID: "project",
          directory,
          title: "Fix the login form",
          version: "1",
          time: { created: 1, updated: state.updated },
          cost: state.cost,
        }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }
  const saved: { costUsd?: number; updatedAt: number }[] = []
  const economics = createSessionEconomics({
    client: (dir) => createVectorClient({ baseUrl: "http://engine.test", fetch, directory: dir }),
    working: () => false,
    cached: () => undefined,
    save: async (sample) => {
      saved.push({ costUsd: sample.outcome?.costUsd, updatedAt: sample.updatedAt })
    },
    activated() {},
    workspaces: async () => true,
  })
  return { requests, saved, economics }
}

async function settle(requests: string[]) {
  for (let quiet = 0; quiet < 3; ) {
    const before = requests.length
    await Bun.sleep(10)
    quiet = requests.length === before ? quiet + 1 : 0
  }
}

const idle = { type: "session.idle", properties: { sessionID: "ses_root" } } as Event

test("a settled root reads its metadata twice around its history, not three times", async () => {
  const ctx = setup({ writeDuringHistory: false })
  ctx.economics.handle({ name: directory, details: idle })
  await settle(ctx.requests)
  ctx.economics.dispose()

  // The family walk's read is the snapshot taken before the history; one more read checks nothing changed since.
  expect(ctx.requests).toEqual(["/session/ses_root", "/session/ses_root/message", "/session/ses_root"])
  expect(ctx.saved).toEqual([{ costUsd: 0.004, updatedAt: 10 }])
})

test("a write during the history read discards that snapshot and records the newer one", async () => {
  const ctx = setup({ writeDuringHistory: true })
  ctx.economics.handle({ name: directory, details: idle })
  await settle(ctx.requests)
  ctx.economics.dispose()

  // The retry cannot reuse the walk's read, which is now stale, so it takes a snapshot of its own.
  expect(ctx.requests).toEqual([
    "/session/ses_root",
    "/session/ses_root/message",
    "/session/ses_root",
    "/session/ses_root",
    "/session/ses_root/message",
    "/session/ses_root",
  ])
  expect(ctx.saved).toHaveLength(1)
  expect(ctx.saved[0]?.updatedAt).toBe(11)
  expect(ctx.saved[0]?.costUsd).toBeCloseTo(0.0043, 10)
})
