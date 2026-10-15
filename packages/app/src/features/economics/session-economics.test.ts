import { expect, test } from "bun:test"
import { createVectorClient, type Event, type Session } from "@vectordevai/sdk/v2/client"
import { createSessionEconomics } from "./session-economics"

const directory = "/repo"
const model = { providerID: "openai", modelID: "gpt-6.1" }

// One idle root whose history is read through the real SDK client. `writeDuringHistory` makes the engine write the
// session while its history is being read, as a late title or subagent spend can.
function setup(input: {
  writeDuringHistory: boolean
  // Called once the engine has written the session during the history read, before the history is answered.
  onWrite?: () => void
  working?: () => boolean
  cached?: (id: string) => Session | undefined
}) {
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
  const info = (): Session => ({
    id: "ses_root",
    slug: "ses_root",
    projectID: "project",
    directory,
    title: "Fix the login form",
    version: "1",
    time: { created: 1, updated: state.updated },
    cost: state.cost,
  })
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname
    requests.push(path)
    if (path.endsWith("/message") && input.writeDuringHistory && !state.wrote) {
      state.wrote = true
      state.updated += 1
      state.cost += 0.0003
      input.onWrite?.()
    }
    const body = path.endsWith("/message") ? history : info()
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }
  const saved: { costUsd?: number; updatedAt: number }[] = []
  const economics = createSessionEconomics({
    client: (dir) => createVectorClient({ baseUrl: "http://engine.test", fetch, directory: dir }),
    working: input.working ?? (() => false),
    cached: input.cached ?? (() => undefined),
    save: async (sample) => {
      saved.push({ costUsd: sample.outcome?.costUsd, updatedAt: sample.updatedAt })
    },
    activated() {},
    workspaces: async () => true,
  })
  return { requests, saved, economics, state, info }
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

test("a root update event during the history read records the run at the newer revision", async () => {
  // A root's own session.updated never triggers its family; only the recorder hears it. The engine forks the step
  // summary, so its update can land after idle, while the history read is in flight.
  const ctx = setup({
    writeDuringHistory: true,
    onWrite: () =>
      ctx.economics.handle({
        name: directory,
        details: { type: "session.updated", properties: { sessionID: "ses_root", info: ctx.info() } } as Event,
      }),
  })
  ctx.economics.handle({ name: directory, details: idle })
  await settle(ctx.requests)
  ctx.economics.dispose()

  // The superseded read stops after its history; the retry reads the newer revision on its own.
  expect(ctx.requests).toEqual([
    "/session/ses_root",
    "/session/ses_root/message",
    "/session/ses_root",
    "/session/ses_root/message",
    "/session/ses_root",
  ])
  expect(ctx.saved).toHaveLength(1)
  expect(ctx.saved[0]?.updatedAt).toBe(11)
  expect(ctx.saved[0]?.costUsd).toBeCloseTo(0.0043, 10)
})

const status = (type: "busy" | "idle") =>
  ({ type: "session.status", properties: { sessionID: "ses_root", status: { type } } }) as Event

test("the idle status and the idle event settle a run once, in either order", async () => {
  for (const order of ["one flush", "status first"]) {
    const state = { working: true }
    const ctx = setup({ writeDuringHistory: false, working: () => state.working })
    // The layout reconciles the status snapshot after each flush of events.
    ctx.economics.handle({ name: directory, details: status("busy") })
    ctx.economics.reconcile([ctx.info()])
    state.working = false
    ctx.economics.handle({ name: directory, details: status("idle") })
    if (order === "status first") ctx.economics.reconcile([ctx.info()])
    ctx.economics.handle({ name: directory, details: idle })
    ctx.economics.reconcile([ctx.info()])
    await settle(ctx.requests)
    ctx.economics.dispose()

    expect(ctx.requests).toEqual(["/session/ses_root", "/session/ses_root/message", "/session/ses_root"])
    expect(ctx.saved).toEqual([{ costUsd: 0.004, updatedAt: 10 }])
  }
})

test("a run that starts and stops within one flush still settles after a reconnect snapshot", async () => {
  const state = { working: true }
  const ctx = setup({ writeDuringHistory: false, working: () => state.working })
  ctx.economics.reconcile([ctx.info()])
  state.working = false
  // Reconnect bootstrap settles the run without its idle event.
  ctx.economics.reconcile([ctx.info()])
  await settle(ctx.requests)
  ctx.state.updated += 1
  ctx.state.cost += 0.002
  // A short failed run: the snapshot after this flush never sees it busy, so only its events can settle it.
  ctx.economics.handle({ name: directory, details: status("busy") })
  ctx.economics.handle({ name: directory, details: status("idle") })
  ctx.economics.handle({ name: directory, details: idle })
  ctx.economics.reconcile([ctx.info()])
  await settle(ctx.requests)
  ctx.economics.dispose()

  expect(ctx.saved.map((sample) => sample.updatedAt)).toEqual([10, 11])
})

test("reconnect status reconciliation captures a run whose idle event was missed", async () => {
  const state = { working: true }
  const ctx = setup({ writeDuringHistory: false, working: () => state.working })
  const session = {
    id: "ses_root",
    slug: "root",
    projectID: "project",
    directory,
    title: "Task",
    version: "1",
    time: { created: 1, updated: 10 },
  }
  ctx.economics.reconcile([session])
  state.working = false
  // Reconnect bootstrap can remove idle sessions from the status map entirely.
  ctx.economics.reconcile([])
  await settle(ctx.requests)
  ctx.economics.dispose()
  expect(ctx.saved).toEqual([{ costUsd: 0.004, updatedAt: 10 }])
  expect(ctx.requests.filter((path) => path.endsWith("/message"))).toHaveLength(1)
})

test("a helper that finishes after its launching task refreshes that task's spend", async () => {
  const helper: Session = {
    id: "ses_helper",
    parentID: "ses_root",
    internal: "vectorscope.review",
    slug: "helper",
    projectID: "project",
    directory,
    title: "Review",
    version: "1",
    time: { created: 1, updated: 11 },
  }
  const ctx = setup({ writeDuringHistory: false, cached: (id) => (id === helper.id ? helper : undefined) })
  ctx.economics.handle({ name: directory, details: idle })
  await settle(ctx.requests)
  ctx.state.cost += 0.02
  ctx.state.updated += 1
  ctx.economics.handle({
    name: directory,
    details: { type: "session.idle", properties: { sessionID: helper.id } } as Event,
  })
  await settle(ctx.requests)
  ctx.economics.dispose()
  expect(ctx.saved.map((sample) => sample.costUsd)).toEqual([0.004, 0.024])
  expect(ctx.requests.some((path) => path.includes(helper.id))).toBe(false)
})

test("autocomplete spend waits for the task to settle without fetching history on each pause", async () => {
  const helper: Session = {
    id: "ses_helper",
    parentID: "ses_root",
    internal: "codespace.autocomplete",
    slug: "helper",
    projectID: "project",
    directory,
    title: "Autocomplete",
    version: "1",
    time: { created: 1, updated: 11 },
  }
  const state = { working: true }
  const ctx = setup({
    writeDuringHistory: false,
    cached: (id) => (id === helper.id ? helper : undefined),
    working: () => state.working,
  })
  ctx.economics.reconcile([helper])
  state.working = false
  ctx.economics.reconcile([helper])
  ctx.economics.handle({
    name: directory,
    details: { type: "session.idle", properties: { sessionID: helper.id } } as Event,
  })
  await settle(ctx.requests)
  expect(ctx.requests).toEqual([])
  ctx.state.cost += 0.02
  ctx.state.updated += 1
  ctx.economics.handle({ name: directory, details: idle })
  await settle(ctx.requests)
  ctx.economics.dispose()
  expect(ctx.saved).toEqual([{ costUsd: 0.024, updatedAt: 11 }])
})
