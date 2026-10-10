import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { CloudEnvVar } from "./cloud-api"
import { createCloudEnvironment } from "./cloud-environment"

function fixture() {
  const projects = new Map<string, CloudEnvVar[]>()
  const writes: { projectPath: string; taskId?: string; variables: CloudEnvVar[] }[] = []
  const notices: { tone: "success" | "error"; text: string }[] = []
  const api = {
    env: {
      list: async (projectPath: string) => projects.get(projectPath) ?? [],
      set: async (
        projectPath: string,
        _taskId: string | undefined,
        key: string,
        value: string,
        visibility?: "public" | "server",
      ) => {
        const variables = [
          ...(projects.get(projectPath) ?? []).filter((item) => item.key !== key),
          { key, value, visibility: visibility ?? ("server" as const) },
        ]
        projects.set(projectPath, variables)
        return variables
      },
      remove: async (projectPath: string, _taskId: string | undefined, key: string) => {
        const variables = (projects.get(projectPath) ?? []).filter((item) => item.key !== key)
        projects.set(projectPath, variables)
        return variables
      },
      apply: async (projectPath: string, taskId?: string) => {
        writes.push({ projectPath, taskId, variables: projects.get(projectPath) ?? [] })
        return { written: ".env" }
      },
    },
  }
  return createRoot((dispose) => ({
    api,
    projects,
    writes,
    notices,
    editor: createCloudEnvironment({ api: () => api, notice: (notice) => notices.push(notice) }),
    [Symbol.dispose]: dispose,
  }))
}

describe("Cloud environment scope", () => {
  test("preserves variable casing and exact values, and clears a saved draft", async () => {
    using f = fixture()
    f.editor.changeScope("/project-a", "task-a")
    f.editor.setKey("  mixed_Case  ")
    f.editor.setValue("fixture value # exact")
    await f.editor.save()
    expect(f.projects.get("/project-a")).toEqual([
      { key: "mixed_Case", value: "fixture value # exact", visibility: "server" as const },
    ])
    expect(f.editor.state.key).toBe("")
    expect(f.editor.state.value).toBe("")
    expect(f.editor.state.revealedKey).toBe("")
  })

  test("sends the chosen visibility, or leaves it to the name, and resets it after saving", async () => {
    using f = fixture()
    const sent: (string | undefined)[] = []
    const set = f.api.env.set
    f.api.env.set = (projectPath, taskId, key, value, visibility) => {
      sent.push(visibility)
      return set(projectPath, taskId, key, value, visibility)
    }
    f.editor.changeScope("/project-a")
    f.editor.setKey("SUPABASE_URL")
    f.editor.setValue("https://fixture.supabase.co")
    f.editor.setVisibility("public")
    await f.editor.save()
    expect(f.editor.state.visibility).toBe("")
    f.editor.setKey("STRIPE_SECRET")
    f.editor.setValue("fixture")
    await f.editor.save()
    expect(sent).toEqual(["public", undefined])
    expect(f.projects.get("/project-a")?.map((item) => item.visibility)).toEqual(["public", "server"])
  })

  test("allows applying the empty list after the final removal", async () => {
    using f = fixture()
    f.projects.set("/project-a", [{ key: "REMOVE_ME", value: "fixture", visibility: "server" as const }])
    f.editor.changeScope("/project-a", "task-a")
    await f.editor.refresh()
    f.editor.reveal("REMOVE_ME")
    await f.editor.remove("REMOVE_ME")
    expect(f.editor.state.variables).toEqual([])
    expect(f.editor.state.revealedKey).toBe("")
    await f.editor.apply()
    expect(f.writes).toEqual([{ projectPath: "/project-a", taskId: "task-a", variables: [] }])
    expect(f.notices.at(-1)?.text).toContain("Cleared Vector's managed variables")
  })

  test("does not mistake unloaded or failed variable state for a confirmed empty list", async () => {
    using f = fixture()
    f.editor.changeScope("/project-a")
    await f.editor.apply()
    f.api.env.list = async () => {
      throw new Error("fixture read failed")
    }
    await f.editor.refresh()
    await f.editor.apply()
    expect(f.writes).toEqual([])
    expect(f.editor.state.loaded).toBe(false)
    f.api.env.list = async () => []
    await f.editor.refresh()
    await f.editor.apply()
    expect(f.writes).toEqual([{ projectPath: "/project-a", taskId: undefined, variables: [] }])
  })

  test("drops a delayed save response and sensitive view state after changing projects", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudEnvVar[]>()
    f.api.env.set = () => pending.promise
    f.projects.set("/project-b", [{ key: "PUBLIC_LABEL", value: "project-b", visibility: "server" as const }])
    f.editor.changeScope("/project-a", "task-a")
    f.editor.setKey("API_KEY")
    f.editor.setValue("fixture-a-only")
    f.editor.reveal("API_KEY")
    const saving = f.editor.save()
    f.editor.changeScope("/project-b", "task-b")
    expect(f.editor.state.value).toBe("")
    expect(f.editor.state.key).toBe("")
    expect(f.editor.state.revealedKey).toBe("")
    await f.editor.refresh()
    pending.resolve([{ key: "API_KEY", value: "fixture-a-only", visibility: "server" as const }])
    await saving
    expect(f.editor.state.variables).toEqual([
      { key: "PUBLIC_LABEL", value: "project-b", visibility: "server" as const },
    ])
    expect(f.editor.state.busy).toBe("")
    expect(f.notices).toEqual([])
  })

  test("changing tasks masks values and invalidates the previous view in the same project", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudEnvVar[]>()
    f.api.env.list = () => pending.promise
    f.editor.changeScope("/project-a", "task-a")
    f.editor.setValue("fixture-unsaved")
    f.editor.reveal("API_KEY")
    const loading = f.editor.refresh()
    f.editor.changeScope("/project-a", "task-b")
    pending.resolve([{ key: "API_KEY", value: "old-view", visibility: "server" as const }])
    await loading
    expect(f.editor.state.variables).toEqual([])
    expect(f.editor.state.value).toBe("")
    expect(f.editor.state.revealedKey).toBe("")
  })

  test("switching away and back cannot revive an earlier response or clear a newer busy state", async () => {
    using f = fixture()
    const first = Promise.withResolvers<CloudEnvVar[]>()
    const second = Promise.withResolvers<CloudEnvVar[]>()
    f.api.env.remove = () => first.promise
    f.editor.changeScope("/project-a")
    const removing = f.editor.remove("OLD")
    f.editor.changeScope("/project-b")
    f.editor.changeScope("/project-a")
    f.api.env.set = () => second.promise
    f.editor.setKey("NEW")
    f.editor.setValue("new-view")
    const saving = f.editor.save()
    first.resolve([{ key: "STALE", value: "old-view", visibility: "server" as const }])
    await removing
    expect(f.editor.state.variables).toEqual([])
    expect(f.editor.state.busy).toBe("save")
    second.resolve([{ key: "NEW", value: "new-view", visibility: "server" as const }])
    await saving
    expect(f.editor.state.variables).toEqual([{ key: "NEW", value: "new-view", visibility: "server" as const }])
  })

  test.each(["before", "during"])("a refresh started %s a mutation cannot overwrite its result", async (timing) => {
    using f = fixture()
    const saved = Promise.withResolvers<CloudEnvVar[]>()
    const loaded = Promise.withResolvers<CloudEnvVar[]>()
    f.api.env.set = () => saved.promise
    f.api.env.list = () => loaded.promise
    f.editor.changeScope("/project-a")
    f.editor.setKey("NEW")
    f.editor.setValue("current-view")
    const before = timing === "before" ? f.editor.refresh() : undefined
    const saving = f.editor.save()
    const loading = before ?? f.editor.refresh()
    saved.resolve([{ key: "NEW", value: "current-view", visibility: "server" as const }])
    await saving
    loaded.resolve([{ key: "OLD", value: "stale-view", visibility: "server" as const }])
    await loading
    expect(f.editor.state.variables).toEqual([{ key: "NEW", value: "current-view", visibility: "server" as const }])
  })

  test("a failed prior project operation cannot display an error in the new project", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudEnvVar[]>()
    f.api.env.remove = () => pending.promise
    f.editor.changeScope("/project-a")
    const removing = f.editor.remove("OLD")
    f.editor.changeScope("/project-b")
    pending.reject(new Error("fixture-a failure"))
    await removing
    expect(f.notices).toEqual([])
    expect(f.editor.state.busy).toBe("")
  })

  test("prevents overlapping mutations and ignores an old write's success", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<{ written: string }>()
    const calls: string[] = []
    f.api.env.apply = (projectPath) => {
      calls.push(projectPath)
      return pending.promise
    }
    f.editor.changeScope("/project-a")
    await f.editor.refresh()
    const writing = f.editor.apply()
    f.editor.setKey("SECOND")
    await f.editor.save()
    expect(f.projects.get("/project-a")).toBeUndefined()
    f.editor.changeScope("/project-b")
    pending.resolve({ written: ".env" })
    await writing
    expect(calls).toEqual(["/project-a"])
    expect(f.notices).toEqual([])
  })

  test("disposal clears sensitive state and discards a pending response", async () => {
    const f = fixture()
    const pending = Promise.withResolvers<CloudEnvVar[]>()
    f.api.env.list = () => pending.promise
    f.editor.changeScope("/project-a")
    f.editor.setValue("fixture-unsaved")
    const loading = f.editor.refresh()
    f[Symbol.dispose]()
    pending.resolve([{ key: "OLD", value: "stale-view", visibility: "server" as const }])
    await loading
    expect(f.editor.state.variables).toEqual([])
    expect(f.editor.state.value).toBe("")
  })
})
