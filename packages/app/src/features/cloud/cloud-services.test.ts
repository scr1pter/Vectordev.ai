import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { CloudSupabaseServices } from "./cloud-api"
import { createCloudServices } from "./cloud-services"

function snapshot(projectRef: string): CloudSupabaseServices {
  return {
    connected: true,
    projectRef,
    storage: { available: true, buckets: [{ id: `${projectRef}-bucket`, name: projectRef, public: false }] },
    functions: { available: true, functions: [] },
  }
}

function fixture() {
  const api = { supabase: async (projectPath: string, _taskId?: string) => snapshot(projectPath) }
  return createRoot((dispose) => ({
    api,
    services: createCloudServices({ api: () => api }),
    [Symbol.dispose]: dispose,
  }))
}

describe("Cloud service scope", () => {
  test.each(["project", "task"])("drops delayed services after changing the %s", async (kind) => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudSupabaseServices>()
    f.api.supabase = () => pending.promise
    f.services.changeScope("/project-a", "task-a")
    const loading = f.services.refresh()
    f.services.changeScope(kind === "project" ? "/project-b" : "/project-a", "task-b")
    pending.resolve(snapshot("old-project"))
    await loading
    expect(f.services.state.snapshot).toBeUndefined()
    expect(f.services.state.busy).toBe(false)
    expect(f.services.state.loaded).toBe(false)
  })

  test("switching away and back cannot restore a stale service snapshot or error", async () => {
    using f = fixture()
    const old = Promise.withResolvers<CloudSupabaseServices>()
    const current = Promise.withResolvers<CloudSupabaseServices>()
    f.api.supabase = () => old.promise
    f.services.changeScope("/project-a")
    const previous = f.services.refresh()
    f.services.changeScope("/project-b")
    f.services.changeScope("/project-a")
    f.api.supabase = () => current.promise
    const loading = f.services.refresh()
    old.reject(new Error("Old project failed"))
    await previous
    expect(f.services.state.busy).toBe(true)
    expect(f.services.state.error).toBe("")
    current.resolve(snapshot("current-project"))
    await loading
    expect(f.services.state.snapshot?.projectRef).toBe("current-project")
  })

  test("changing the linked database invalidates an in-flight read in the same scope", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudSupabaseServices>()
    f.api.supabase = () => pending.promise
    f.services.changeScope("/project-a")
    const loading = f.services.refresh()
    f.services.reset()
    pending.resolve(snapshot("previous-database"))
    await loading
    expect(f.services.state.snapshot).toBeUndefined()
    expect(f.services.state.loaded).toBe(false)
  })

  test("reports a failed first load and recovers on retry without duplicating a pending read", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudSupabaseServices>()
    const calls: string[] = []
    f.api.supabase = (projectPath) => {
      calls.push(projectPath)
      return pending.promise
    }
    f.services.changeScope("/project-a")
    const loading = f.services.refresh()
    await f.services.refresh()
    expect(calls).toEqual(["/project-a"])
    pending.reject(new Error("Supabase temporarily unavailable"))
    await loading
    expect(f.services.state.snapshot).toBeUndefined()
    expect(f.services.state.error).toBe("Supabase temporarily unavailable")
    expect(f.services.state.loaded).toBe(true)
    expect(f.services.state.busy).toBe(false)
    f.api.supabase = async () => snapshot("recovered")
    await f.services.refresh()
    expect(f.services.state.snapshot?.projectRef).toBe("recovered")
    expect(f.services.state.error).toBe("")
  })

  test("a failed refresh preserves the last successful service snapshot", async () => {
    using f = fixture()
    f.services.changeScope("/project-a")
    await f.services.refresh()
    f.api.supabase = async () => {
      throw new Error("Connection lost")
    }
    await f.services.refresh()
    expect(f.services.state.snapshot?.projectRef).toBe("/project-a")
    expect(f.services.state.error).toBe("Connection lost")
  })

  test("disposal clears service data and discards delayed results", async () => {
    const f = fixture()
    const pending = Promise.withResolvers<CloudSupabaseServices>()
    f.api.supabase = () => pending.promise
    f.services.changeScope("/project-a")
    const loading = f.services.refresh()
    f[Symbol.dispose]()
    pending.resolve(snapshot("old-project"))
    await loading
    expect(f.services.state.snapshot).toBeUndefined()
    expect(f.services.state.busy).toBe(false)
  })
})
