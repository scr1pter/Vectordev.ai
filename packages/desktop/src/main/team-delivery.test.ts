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

const { createAgentTeam, addTeamMember, pendingFor: _unused, getAgentTeam } = await import("./agent-teams")
const { pendingFor } = await import("./agent-team-model")
const { sweepTeamOutboxes } = await import("./parallel-workspaces")

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
    store.set("parallel-workspaces-state", new Map([["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath }))]]))

    await writeFile(
      join(alpha.isolatedPath, ".vector", "team-outbox.jsonl"),
      JSON.stringify({ to: "Beta", message: "I renamed the auth module, adjust your imports", sessionID: "ses_a" }) + "\n",
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
    store.set("parallel-workspaces-state", new Map([["records", [alpha, beta].map((m) => ({ ...m, sourcePath: userDataPath }))]]))

    await writeFile(
      join(alpha.isolatedPath, ".vector", "team-outbox.jsonl"),
      ["{ this is not json", JSON.stringify({ to: "Beta", message: "second line still lands", sessionID: "ses_a" })].join(
        "\n",
      ) + "\n",
      "utf8",
    )

    await sweepTeamOutboxes(team.id)

    const stored = getAgentTeam(team.id)!
    expect(pendingFor(stored, beta.id).map((item) => item.text)).toContain("second line still lands")
  })
})
