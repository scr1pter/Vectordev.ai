import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { CloudApi, CloudBuildSettings } from "./cloud-api"
import { createCloudBuild } from "./cloud-build"

function settings(project: string): CloudBuildSettings {
  return {
    framework: project,
    packageManager: "bun",
    installCommand: `bun install --cwd ${project}`,
    testCommand: "bun test",
    buildCommand: `bun run build:${project}`,
    outputDirectory: `${project}/dist`,
    nodeVersion: "20.x",
    healthPath: "/health",
    requiredChecks: { test: true, secrets: true, health: true, browser: false },
    source: "custom",
    updatedAt: "2026-10-07T00:00:00Z",
  }
}

function fixture() {
  const notices: { tone: "success" | "error"; text: string }[] = []
  const writes: { projectPath: string; taskId?: string; buildCommand: string }[] = []
  const api: CloudApi["build"] = {
    get: async (projectPath) => settings(projectPath),
    detect: async (projectPath) => settings(projectPath),
    set: async (projectPath, taskId, draft) => {
      writes.push({ projectPath, taskId, buildCommand: draft.buildCommand })
      return { ...draft, source: "custom", updatedAt: "2026-10-07T00:00:00Z" }
    },
  }
  return createRoot((dispose) => ({
    api,
    writes,
    notices,
    build: createCloudBuild({ api: () => api, notice: (notice) => notices.push(notice) }),
    [Symbol.dispose]: dispose,
  }))
}

describe("Cloud build project scope", () => {
  test("a repository without saved settings cannot inherit the previous repository's commands", async () => {
    using f = fixture()
    f.build.changeScope("/project-a")
    await f.build.refresh()
    expect(f.build.state.draft.buildCommand).toBe("bun run build:/project-a")
    f.build.changeScope("/project-b")
    expect(f.build.state.settings).toBeNull()
    expect(f.build.state.draft.buildCommand).toBe("")
    f.api.get = async () => null
    await f.build.refresh()
    await f.build.save()
    expect(f.writes).toEqual([{ projectPath: "/project-b", taskId: undefined, buildCommand: "" }])
  })

  test("drops an old repository's delayed settings", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudBuildSettings | null>()
    f.api.get = () => pending.promise
    f.build.changeScope("/project-a")
    const loading = f.build.refresh()
    f.build.changeScope("/project-b")
    pending.resolve(settings("old-project"))
    await loading
    expect(f.build.state.settings).toBeNull()
    expect(f.build.state.draft.buildCommand).toBe("")
  })

  test("task changes clear the draft and suppress the old task's save result", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudBuildSettings>()
    f.api.set = () => pending.promise
    f.build.changeScope("/project-a", "task-a")
    f.build.setDraft((draft) => ({ ...draft, buildCommand: "task-a-only" }))
    const saving = f.build.save()
    f.build.changeScope("/project-a", "task-b")
    pending.resolve(settings("task-a"))
    await saving
    expect(f.build.state.draft.buildCommand).toBe("")
    expect(f.build.state.settings).toBeNull()
    expect(f.notices).toEqual([])
  })

  test("switching away and back cannot revive a detection or clear the new operation's busy state", async () => {
    using f = fixture()
    const old = Promise.withResolvers<CloudBuildSettings>()
    const current = Promise.withResolvers<CloudBuildSettings>()
    f.build.changeScope("/project-a")
    f.api.detect = () => old.promise
    const previous = f.build.detect()
    f.build.changeScope("/project-b")
    f.build.changeScope("/project-a")
    f.api.detect = () => current.promise
    const detecting = f.build.detect()
    old.reject(new Error("Old detection failed"))
    await previous
    expect(f.build.state.busy).toBe("detect")
    expect(f.notices).toEqual([])
    current.resolve(settings("current-project"))
    await detecting
    expect(f.build.state.draft.buildCommand).toBe("bun run build:current-project")
    expect(f.build.state.busy).toBe("")
    expect(Object.keys(f.build.state.draft)).not.toContain("updatedAt")
  })

  test("a late initial read does not overwrite a user-edited draft or successful save", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudBuildSettings | null>()
    f.api.get = () => pending.promise
    f.build.changeScope("/project-a")
    const loading = f.build.refresh()
    f.build.setDraft((draft) => ({ ...draft, buildCommand: "new-command" }))
    await f.build.save()
    pending.resolve(settings("old-settings"))
    await loading
    expect(f.build.state.draft.buildCommand).toBe("new-command")
    expect(f.build.state.settings?.buildCommand).toBe("new-command")
  })

  test("the latest refresh wins when same-project reads complete out of order", async () => {
    using f = fixture()
    const old = Promise.withResolvers<CloudBuildSettings | null>()
    const current = Promise.withResolvers<CloudBuildSettings | null>()
    f.build.changeScope("/project-a")
    f.api.get = () => old.promise
    const previous = f.build.refresh()
    f.api.get = () => current.promise
    const refreshing = f.build.refresh()
    current.resolve(settings("new-settings"))
    await refreshing
    old.resolve(settings("old-settings"))
    await previous
    expect(f.build.state.settings?.buildCommand).toBe("bun run build:new-settings")
    expect(f.build.state.draft.buildCommand).toBe("bun run build:new-settings")
  })

  test("serializes detection and saving and recovers from failed detection", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudBuildSettings>()
    f.api.detect = () => pending.promise
    f.build.changeScope("/project-a")
    const detecting = f.build.detect()
    await f.build.save()
    expect(f.writes).toEqual([])
    pending.reject(new Error("Cannot detect this project"))
    await detecting
    expect(f.build.state.busy).toBe("")
    expect(f.notices.at(-1)?.text).toBe("Cannot detect this project")
    f.api.detect = async () => settings("detected")
    await f.build.detect()
    expect(f.build.state.draft.buildCommand).toBe("bun run build:detected")
  })

  test("disposal prevents a pending operation from restoring a draft", async () => {
    const f = fixture()
    const pending = Promise.withResolvers<CloudBuildSettings>()
    f.api.detect = () => pending.promise
    f.build.changeScope("/project-a")
    const detecting = f.build.detect()
    f[Symbol.dispose]()
    pending.resolve(settings("old-project"))
    await detecting
    expect(f.build.state.settings).toBeNull()
    expect(f.build.state.draft.buildCommand).toBe("")
    expect(f.notices).toEqual([])
  })
})
