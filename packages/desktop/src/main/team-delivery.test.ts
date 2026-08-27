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
  isInternalWorkspaceFile,
  nextVectorTeammateDelivery,
  pendingTeammateDelivery,
  sweepTeamOutboxes,
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
