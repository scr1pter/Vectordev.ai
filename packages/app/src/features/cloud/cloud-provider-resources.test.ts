import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { CloudProviderId, CloudProviderResource } from "./cloud-api"
import { createCloudProviderResources } from "./cloud-provider-resources"

function fixture() {
  const api = { resources: async (_provider: CloudProviderId): Promise<CloudProviderResource[]> => [] }
  return createRoot((dispose) => ({
    api,
    resources: createCloudProviderResources({ api: () => api }),
    [Symbol.dispose]: dispose,
  }))
}

describe("Cloud provider project loading", () => {
  test("distinguishes a failed read from an empty account and recovers on retry", async () => {
    using f = fixture()
    f.api.resources = async () => {
      throw new Error("Provider temporarily unavailable")
    }
    await f.resources.refresh("vercel")
    expect(f.resources.state.vercel.loaded).toBe(false)
    expect(f.resources.state.vercel.error).toBe("Provider temporarily unavailable")
    expect(f.resources.state.vercel.loading).toBe(false)

    f.api.resources = async () => []
    await f.resources.refresh("vercel")
    expect(f.resources.state.vercel.loaded).toBe(true)
    expect(f.resources.state.vercel.error).toBe("")
    expect(f.resources.state.vercel.items).toEqual([])
  })

  test("preserves a successful project list when a refresh fails", async () => {
    using f = fixture()
    const project: CloudProviderResource = { provider: "supabase", id: "project-a", name: "Project A" }
    f.api.resources = async () => [project]
    await f.resources.refresh("supabase")
    f.api.resources = async () => {
      throw new Error("Network unavailable")
    }
    await f.resources.refresh("supabase")
    expect(f.resources.state.supabase.items).toEqual([project])
    expect(f.resources.state.supabase.loaded).toBe(true)
    expect(f.resources.state.supabase.error).toBe("Network unavailable")
  })

  test("a delayed request cannot restore projects after disconnecting", async () => {
    using f = fixture()
    const pending = Promise.withResolvers<CloudProviderResource[]>()
    f.api.resources = () => pending.promise
    const loading = f.resources.refresh("netlify")
    expect(f.resources.state.netlify.loading).toBe(true)
    f.resources.clear("netlify")
    pending.resolve([{ provider: "netlify", id: "old-account", name: "Old account" }])
    await loading
    expect(f.resources.state.netlify).toEqual({ items: [], loading: false, loaded: false, error: "" })
  })

  test("a new account load wins over an old load, without clearing its loading state", async () => {
    using f = fixture()
    const old = Promise.withResolvers<CloudProviderResource[]>()
    const current = Promise.withResolvers<CloudProviderResource[]>()
    f.api.resources = () => old.promise
    const previous = f.resources.refresh("vercel")
    f.resources.clear("vercel")
    f.api.resources = () => current.promise
    const loading = f.resources.refresh("vercel")
    old.reject(new Error("Old account rejected"))
    await previous
    expect(f.resources.state.vercel.loading).toBe(true)
    expect(f.resources.state.vercel.error).toBe("")
    current.resolve([{ provider: "vercel", id: "new", name: "New account project" }])
    await loading
    expect(f.resources.state.vercel.items.map((item) => item.id)).toEqual(["new"])
  })

  test("one provider's failure does not suppress another provider's projects", async () => {
    using f = fixture()
    f.api.resources = async (provider) => {
      if (provider === "vercel") throw new Error("Vercel unavailable")
      return [{ provider, id: "working", name: "Working project" }]
    }
    await Promise.all([f.resources.refresh("vercel"), f.resources.refresh("netlify")])
    expect(f.resources.state.vercel.error).toBe("Vercel unavailable")
    expect(f.resources.state.netlify.items.map((item) => item.id)).toEqual(["working"])
    expect(f.resources.state.netlify.error).toBe("")
  })

  test("disposal invalidates pending project results", async () => {
    const f = fixture()
    const pending = Promise.withResolvers<CloudProviderResource[]>()
    f.api.resources = () => pending.promise
    const loading = f.resources.refresh("supabase")
    f[Symbol.dispose]()
    pending.resolve([{ provider: "supabase", id: "old", name: "Old project" }])
    await loading
    expect(f.resources.state.supabase.items).toEqual([])
    expect(f.resources.state.supabase.loading).toBe(false)
  })
})
