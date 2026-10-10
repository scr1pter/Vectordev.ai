import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let userDataPath = ""
const store = new Map<string, Map<string, unknown>>()
// parallel-workspaces pulls in the cloud and publish modules transitively, so
// the stub has to cover every electron export they touch at module load.
const electronMock = {
  app: { isPackaged: false, getPath: () => userDataPath, getVersion: () => "test", on: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => undefined, openPath: async () => "" },
  BrowserWindow: class {},
  ipcMain: { handle: () => undefined, on: () => undefined },
  Notification: class {
    static isSupported() {
      return false
    }
  },
  dialog: {},
  clipboard: {},
  systemPreferences: {},
  utilityProcess: {},
  net: {},
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
mock.module("./store", () => ({
  getStore: (name = "default") => {
    if (!store.has(name)) store.set(name, new Map())
    const bucket = store.get(name)!
    return {
      get: (key: string) => bucket.get(key),
      set: (key: string, value: unknown) => bucket.set(key, value),
      delete: (key: string) => bucket.delete(key),
      path: join(userDataPath, `${name}.json`),
    }
  },
  removeStoreFileIfEmpty: () => undefined,
}))

const {
  createAgentTeam,
  addTeamMember,
  pendingFor: _unused,
  getAgentTeam,
  postTeamMessage,
} = await import("./agent-teams")
const { pendingFor } = await import("./agent-team-model")
const {
  createParallelWorkspace,
  getParallelWorkspace,
  isInternalWorkspaceFile,
  nextVectorTeammateDelivery,
  pendingTeammateDelivery,
  sweepTeamOutboxes,
  runParallelWorkspace,
  stopParallelWorkspace,
  vectorPromptMessageId,
} = await import("./parallel-workspaces")

// Teammate delivery only ever happens at a turn boundary, and every member of a
// team starts at the same moment. Draining only after a run finished meant the
// window in which anyone could receive a message never existed: the tool told
// the agent its message was queued for "the start of their next turn", and there
// was no next turn.
describe("team outbox delivery while members are running", () => {
  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), "vector-team-delivery-"))
    store.clear()
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  const member = async (name: string) => {
    const isolatedPath = join(userDataPath, name)
    await mkdir(join(isolatedPath, ".vector"), { recursive: true })
    return { id: `ws-${name}`, name, isolatedPath }
  }

  test("a message written mid-run reaches the recipient before either finishes", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)

    // Both records must be discoverable the way the sweep finds them.
    store.set(
      "parallel-workspaces-state",
      new Map([["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath }))]]),
    )

    await writeFile(
      join(alpha.isolatedPath, ".vector", "team-outbox.jsonl"),
      JSON.stringify({
        id: "message-1",
        to: "Beta",
        message: "I renamed the auth module, adjust your imports",
        sessionID: "ses_a",
      }) + "\n",
      "utf8",
    )

    await sweepTeamOutboxes(team.id)

    const stored = getAgentTeam(team.id)!
    const waiting = pendingFor(stored, beta.id)
    expect(waiting.map((item) => item.text)).toContain("I renamed the auth module, adjust your imports")
  })

  test("a malformed line does not stop the rest of the outbox routing", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)
    store.set(
      "parallel-workspaces-state",
      new Map([["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath }))]]),
    )

    await writeFile(
      join(alpha.isolatedPath, ".vector", "team-outbox.jsonl"),
      [
        "{ this is not json",
        JSON.stringify({ to: "Beta", message: "second line still lands", sessionID: "ses_a" }),
      ].join("\n") + "\n",
      "utf8",
    )

    await sweepTeamOutboxes(team.id)

    const stored = getAgentTeam(team.id)!
    expect(pendingFor(stored, beta.id).map((item) => item.text)).toContain("second line still lands")
  })

  test("a malformed typed entry does not poison the claimed file", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)
    store.set(
      "parallel-workspaces-state",
      new Map([["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath }))]]),
    )
    await writeFile(
      join(alpha.isolatedPath, ".vector", "team-outbox.jsonl"),
      [
        JSON.stringify({ id: "bad", to: 1, message: {} }),
        JSON.stringify({ id: "good", to: "Beta", message: "typed entry still lands", sessionID: "ses_a" }),
      ].join("\n") + "\n",
    )

    await sweepTeamOutboxes(team.id)

    expect(pendingFor(getAgentTeam(team.id)!, beta.id).map((item) => item.text)).toContain("typed entry still lands")
  })

  test("one unreadable outbox does not block a healthy teammate's messages", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)
    store.set(
      "parallel-workspaces-state",
      new Map([
        ["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath, mergeState: "none", logs: [] }))],
      ]),
    )
    await writeFile(join(alpha.isolatedPath, ".vector", "team-outbox"), "not a directory")
    await writeFile(
      join(beta.isolatedPath, ".vector", "team-outbox.jsonl"),
      `${JSON.stringify({ id: "healthy-outbox", to: "Alpha", message: "still delivered", sessionID: "ses_beta" })}\n`,
    )

    await sweepTeamOutboxes(team.id)

    expect(pendingFor(getAgentTeam(team.id)!, alpha.id).map((message) => message.text)).toEqual(["still delivered"])
    expect(getParallelWorkspace(alpha.id)?.logs[0]).toContain("remain queued for retry")
  })

  test("one failed active recipient stays pending while other teammates receive their messages", async () => {
    const sourcePath = join(userDataPath, "project")
    await mkdir(sourcePath, { recursive: true })
    await writeFile(join(sourcePath, "README.md"), "# Team\n")
    const team = createAgentTeam({ name: "team", topology: "isolated", sourcePath })
    const sessions: string[] = []
    const deliveries: { sessionId: string; id: string }[] = []
    let failingSession: string | undefined
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/session") {
          const id = `ses_team_${sessions.length}`
          sessions.push(id)
          return Response.json({ id })
        }
        if (path === "/api/session/active") {
          return Response.json({ data: Object.fromEntries(sessions.map((id) => [id, {}])) })
        }
        if (path.endsWith("/prompt")) {
          const body = (await request.json()) as { id: string; prompt: { text: string } }
          const sessionId = path.split("/")[3]!
          if (body.prompt.text.startsWith("[vector:teammate-messages]")) {
            deliveries.push({ sessionId, id: body.id })
            if (sessionId === failingSession) return new Response("Temporary failure", { status: 503 })
          }
        }
        return Response.json({ data: [] })
      },
    })
    const engine = { url: server.url.toString(), username: null, password: null }
    const records = []
    try {
      for (const name of ["Alpha", "Beta"]) {
        const record = await createParallelWorkspace({
          sourcePath,
          parentSessionId: "ses_parent",
          taskPrompt: "Inspect README.md.",
          name,
          teamId: team.id,
        })
        addTeamMember(team.id, record.id)
        records.push(record)
        await runParallelWorkspace(record.id, engine)
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          records.every((record) =>
            getParallelWorkspace(record.id)?.logs.some((log) => log.startsWith("Task admitted")),
          )
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(
        records.every((record) => getParallelWorkspace(record.id)?.logs.some((log) => log.startsWith("Task admitted"))),
      ).toBe(true)
      const alpha = records[0]!
      const beta = records[1]!
      // Newer records drain first, so a failed Beta delivery used to prevent
      // Alpha from receiving anything on every sweep.
      failingSession = getParallelWorkspace(beta.id)?.agentSessionId
      expect(failingSession).toBeDefined()
      postTeamMessage({
        teamId: team.id,
        fromWorkspaceId: alpha.id,
        fromName: alpha.name,
        toWorkspaceId: beta.id,
        text: "for Beta",
      })
      postTeamMessage({
        teamId: team.id,
        fromWorkspaceId: beta.id,
        fromName: beta.name,
        toWorkspaceId: alpha.id,
        text: "for Alpha",
      })

      await sweepTeamOutboxes(team.id)

      expect(pendingFor(getAgentTeam(team.id)!, alpha.id)).toEqual([])
      expect(pendingFor(getAgentTeam(team.id)!, beta.id).map((message) => message.text)).toEqual(["for Beta"])
      const retry = deliveries.find((delivery) => delivery.sessionId === failingSession)!
      failingSession = undefined
      await sweepTeamOutboxes(team.id)
      expect(pendingFor(getAgentTeam(team.id)!, beta.id)).toEqual([])
      expect(
        deliveries.filter((delivery) => delivery.sessionId === retry.sessionId).map((delivery) => delivery.id),
      ).toEqual([retry.id, retry.id])
    } finally {
      await Promise.all(records.map((record) => stopParallelWorkspace(record.id)))
      await new Promise((resolve) => setTimeout(resolve, 50))
      server.stop(true)
    }
  })

  test("overlapping sweeps route one durable entry exactly once", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)
    store.set(
      "parallel-workspaces-state",
      new Map([["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath }))]]),
    )
    await writeFile(
      join(alpha.isolatedPath, ".vector", "team-outbox.jsonl"),
      `${JSON.stringify({ id: "once", to: "Beta", message: "deliver once", sessionID: "ses_a" })}\n`,
    )

    await Promise.all([sweepTeamOutboxes(team.id), sweepTeamOutboxes(team.id)])

    expect(getAgentTeam(team.id)!.messages.filter((message) => message.id === "once")).toHaveLength(1)
  })

  test("atomically published per-message outbox files are delivered", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)
    store.set(
      "parallel-workspaces-state",
      new Map([["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath }))]]),
    )
    const outbox = join(alpha.isolatedPath, ".vector", "team-outbox")
    await mkdir(outbox, { recursive: true })
    await writeFile(
      join(outbox, "durable.json"),
      JSON.stringify({ id: "durable", to: "Beta", message: "atomic delivery", sessionID: "ses_a" }),
    )

    await sweepTeamOutboxes(team.id)

    expect(pendingFor(getAgentTeam(team.id)!, beta.id).map((message) => message.text)).toContain("atomic delivery")
  })

  test("replaying a claimed file after a crash is idempotent", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)
    store.set(
      "parallel-workspaces-state",
      new Map([["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath }))]]),
    )
    const line = `${JSON.stringify({ id: "replayed", to: "Beta", message: "survive restart", sessionID: "ses_a" })}\n`
    await Promise.all([
      writeFile(join(alpha.isolatedPath, ".vector", "team-outbox.jsonl.first.processing"), line),
      writeFile(join(alpha.isolatedPath, ".vector", "team-outbox.jsonl.second.processing"), line),
    ])

    await sweepTeamOutboxes(team.id)

    expect(getAgentTeam(team.id)!.messages.filter((message) => message.id === "replayed")).toHaveLength(1)
  })

  test("a misspelled recipient is bounced instead of broadcast", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)
    store.set(
      "parallel-workspaces-state",
      new Map([["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath }))]]),
    )
    await writeFile(
      join(alpha.isolatedPath, ".vector", "team-outbox.jsonl"),
      `${JSON.stringify({ id: "typo", to: "Betta", message: "private detail", sessionID: "ses_a" })}\n`,
    )

    await sweepTeamOutboxes(team.id)

    const stored = getAgentTeam(team.id)!
    expect(pendingFor(stored, beta.id)).toEqual([])
    expect(
      pendingFor(stored, alpha.id)
        .map((message) => message.text)
        .join("\n"),
    ).toContain("Betta")
  })

  test("durable Vector prompt retries reuse an exact message id", () => {
    const first = vectorPromptMessageId("ses_one", "peer update", ["message-a", "message-b"])
    expect(vectorPromptMessageId("ses_one", "peer update", ["message-a", "message-b"])).toBe(first)
    expect(vectorPromptMessageId("ses_one", "peer update", ["message-a"])).not.toBe(first)
    expect(vectorPromptMessageId("ses_two", "peer update", ["message-a", "message-b"])).not.toBe(first)
    expect(first).toStartWith("msg_")
  })

  test("a newly arrived message does not change the in-flight Vector delivery", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)
    postTeamMessage({
      messageId: "message-a",
      teamId: team.id,
      fromWorkspaceId: alpha.id,
      fromName: alpha.name,
      toWorkspaceId: beta.id,
      text: "first",
    })
    const first = nextVectorTeammateDelivery(pendingFor(getAgentTeam(team.id)!, beta.id))

    postTeamMessage({
      messageId: "message-b",
      teamId: team.id,
      fromWorkspaceId: alpha.id,
      fromName: alpha.name,
      toWorkspaceId: beta.id,
      text: "second",
    })

    expect(first.map((message) => message.id)).toEqual(["message-a"])
    expect(
      nextVectorTeammateDelivery(pendingFor(getAgentTeam(team.id)!, beta.id)).map((message) => message.id),
    ).toEqual(["message-a"])
  })

  test("external runtime delivery remains pending until its caller confirms success", async () => {
    const alpha = await member("Alpha")
    const beta = await member("Beta")
    const team = createAgentTeam({ name: "team", topology: "collaborative", sourcePath: userDataPath })
    addTeamMember(team.id, alpha.id)
    addTeamMember(team.id, beta.id)
    postTeamMessage({
      messageId: "retry-me",
      teamId: team.id,
      fromWorkspaceId: alpha.id,
      fromName: alpha.name,
      toWorkspaceId: beta.id,
      text: "do not drop this",
    })

    const delivery = pendingTeammateDelivery(beta, "mission")

    expect(delivery.prompt).toContain("do not drop this")
    expect(delivery.messageIds).toEqual(["retry-me"])
    expect(pendingFor(getAgentTeam(team.id)!, beta.id).map((message) => message.id)).toEqual(["retry-me"])
  })

  test("durable team outbox internals never appear in review diffs", () => {
    expect(isInternalWorkspaceFile(".vector/team-outbox/message.json")).toBe(true)
    expect(isInternalWorkspaceFile(".vector/team-outbox/message.json.processing")).toBe(true)
    expect(isInternalWorkspaceFile(".vector/team-outbox/message.tmp")).toBe(true)
    expect(isInternalWorkspaceFile(".vector/team-outbox.jsonl.crash.processing")).toBe(true)
    expect(isInternalWorkspaceFile(".vector/BRAIN.md")).toBe(false)
  })
})
