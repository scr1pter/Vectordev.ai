import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { CloudOverview } from "@/features/cloud/cloud-api"
import { cloudStatus } from "@/features/cloud/cloud-handoff"
import { createCloudOverview } from "@/features/cloud/cloud-overview"

function snapshot(directory: string, input: Partial<CloudOverview> = {}): CloudOverview {
  return {
    projectPath: directory,
    directory,
    hosting: { provider: "Vercel", connected: true, project: { id: "prj", name: "shop" } },
    database: { provider: "Supabase", accountConnected: false, connected: false },
    ...input,
  }
}

// A stand-in for the desktop's cloud API: `state` is what the desktop would
// answer now, and `change()` is the desktop reporting that cloud state changed.
function fakeCloud() {
  const state = new Map<string, CloudOverview>()
  const listeners = new Set<() => void>()
  const requests: string[] = []
  return {
    state,
    requests,
    change: () => listeners.forEach((listener) => listener()),
    listeners,
    api: {
      overview: async (directory: string) => {
        requests.push(directory)
        const found = state.get(directory)
        if (!found) throw new Error("Vector Cloud could not read this project.")
        return found
      },
      onChange: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}

const settle = () => new Promise((done) => setTimeout(done, 0))

describe("live cloud overview", () => {
  test("follows cloud changes, window focus and the session's directory, and stops when disposed", async () => {
    const cloud = fakeCloud()
    cloud.state.set("/work/shop", snapshot("/work/shop"))
    const [directory, setDirectory] = createSignal<string | undefined>("/work/shop")
    const live = createRoot((dispose) => ({ ...createCloudOverview({ api: cloud.api, directory }), dispose }))
    await settle()
    expect(cloudStatus(live.overview())).toEqual({ tone: "idle", label: "Not published yet" })

    // The agent published and promoted a release: the desktop reports a change.
    const release = {
      id: "dep_1",
      url: "https://shop.vercel.app/",
      environment: "production" as const,
      releaseStatus: "current" as const,
      status: "ready" as const,
      createdAt: "2026-10-10T10:00:00.000Z",
      failedChecks: [],
    }
    cloud.state.set("/work/shop", snapshot("/work/shop", { latest: release, production: release }))
    cloud.change()
    await settle()
    expect(cloudStatus(live.overview())).toEqual({ tone: "success", label: "Live in production" })

    cloud.state.set("/work/shop", snapshot("/work/shop", { database: { ...snapshot("/").database, connected: true } }))
    globalThis.window.dispatchEvent(new Event("focus"))
    await settle()
    expect(live.overview()?.database.connected).toBe(true)

    // A project Vector Cloud cannot read shows why, never the previous project's overview.
    setDirectory("/work/other")
    await settle()
    expect(live.overview()).toBeUndefined()
    expect(live.error()).toBe("Vector Cloud could not read this project.")
    cloud.state.set("/work/other", snapshot("/work/other"))
    await live.refresh()
    expect(live.overview()?.projectPath).toBe("/work/other")
    expect(live.error()).toBe("")

    live.dispose()
    expect(cloud.listeners.size).toBe(0)
    const before = cloud.requests.length
    globalThis.window.dispatchEvent(new Event("focus"))
    await settle()
    expect(cloud.requests).toHaveLength(before)
  })

  test("drops an answer for a directory the session has already left", async () => {
    const cloud = fakeCloud()
    let release: () => void = () => undefined
    const slow = new Promise<void>((done) => (release = done))
    const api = {
      ...cloud.api,
      overview: async (path: string) => {
        if (path === "/work/slow") await slow
        return snapshot(path)
      },
    }
    const [directory, setDirectory] = createSignal<string | undefined>("/work/slow")
    const live = createRoot((dispose) => ({ ...createCloudOverview({ api, directory }), dispose }))
    setDirectory("/work/fast")
    await settle()
    release()
    await settle()
    expect(live.overview()?.projectPath).toBe("/work/fast")
    live.dispose()
  })
})
