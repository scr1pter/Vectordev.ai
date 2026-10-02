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
      set: async (projectPath: string, _taskId: string | undefined, key: string, value: string) => {
        const variables = [...(projects.get(projectPath) ?? []).filter((item) => item.key !== key), { key, value }]
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
    providers: {
      syncEnvironment: async (projectPath: string, _taskId: string | undefined, provider: "vercel" | "netlify") => ({
        provider,
        projectId: projectPath,
        projectName: projectPath,
        changed: projects.get(projectPath)?.length ?? 0,
        syncedAt: "2026-10-02T00:00:00Z",
        detail: `Synced ${projectPath}`,
      }),
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
    expect(f.projects.get("/project-a")).toEqual([{ key: "mixed_Case", value: "fixture value # exact" }])
    expect(f.editor.state.key).toBe("")
    expect(f.editor.state.value).toBe("")
    expect(f.editor.state.revealedKey).toBe("")
  })

  test("allows applying the empty list after the final removal", async () => {
    using f = fixture()
    f.projects.set("/project-a", [{ key: "REMOVE_ME", value: "fixture" }])
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
    f.projects.set("/project-b", [{ key: "PUBLIC_LABEL", value: "project-b" }])
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
    pending.resolve([{ key: "API_KEY", value: "fixture-a-only" }])
    await saving
    expect(f.editor.state.variables).toEqual([{ key: "PUBLIC_LABEL", value: "project-b" }])
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
    pending.resolve([{ key: "API_KEY", value: "old-view" }])
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
    first.resolve([{ key: "STALE", value: "old-view" }])
    await removing
    expect(f.editor.state.variables).toEqual([])
    expect(f.editor.state.busy).toBe("save")
    second.resolve([{ key: "NEW", value: "new-view" }])
    await saving
    expect(f.editor.state.variables).toEqual([{ key: "NEW", value: "new-view" }])
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
    saved.resolve([{ key: "NEW", value: "current-view" }])
    await saving
    loaded.resolve([{ key: "OLD", value: "stale-view" }])
    await loading
    expect(f.editor.state.variables).toEqual([{ key: "NEW", value: "current-view" }])
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

  test("prevents overlapping mutations and ignores an old provider-sync success", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.api.providers.syncEnvironment>>>()
    const calls: string[] = []
    f.api.providers.syncEnvironment = (projectPath) => {
      calls.push(projectPath)
      return pending.promise
    }
    f.editor.changeScope("/project-a")
    await f.editor.refresh()
    const syncing = f.editor.sync("vercel")
    await f.editor.apply()
    expect(f.writes).toEqual([])
    f.editor.changeScope("/project-b")
    pending.resolve({
      provider: "vercel",
      projectId: "a",
      projectName: "a",
      changed: 1,
      syncedAt: "",
      detail: "Old sync",
    })
    await syncing
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
    pending.resolve([{ key: "OLD", value: "stale-view" }])
    await loading
    expect(f.editor.state.variables).toEqual([])
    expect(f.editor.state.value).toBe("")
  })
})
