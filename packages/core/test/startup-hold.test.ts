import { afterEach, describe, expect, test } from "bun:test"
import { FREE_MODEL_FALLBACKS } from "@vectordevai/schema/free-model"
import { FreeModels } from "../src/free-models"
import { StartupHold } from "../src/startup-hold"
import { NetworkGuard } from "./lib/network-guard"

// A desktop first run's engine starts with Vector's own startup fetches held until the person has chosen how to run
// models, and lets them go then, in the same process.

NetworkGuard.use()

const catalog = { enabled: true, updatedAt: 123, models: [...FREE_MODEL_FALLBACKS.slice(0, 2)] }
const endpointsPath = (url: string) => /\/models\/(.+)\/endpoints$/.exec(url)?.[1]
const fixture = await Bun.file(new URL("./fixture/free-model-public-2026-10-17.json", import.meta.url)).json()
const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

afterEach(() => StartupHold.useTestHold(false))

describe("StartupHold", () => {
  test("lets go once, and runs what waited only for a hold this process started with", () => {
    const ran: string[] = []
    StartupHold.onRelease(() => void ran.push("unheld"))
    expect(StartupHold.release()).toBe(false)
    expect(ran).toEqual([])
    StartupHold.useTestHold(true)
    const stop = StartupHold.onRelease(() => void ran.push("stopped"))
    StartupHold.onRelease(() => void ran.push("first"))
    StartupHold.onRelease(() => void ran.push("second"))
    stop()
    expect(StartupHold.held()).toBe(true)
    expect(StartupHold.release()).toBe(true)
    expect(StartupHold.held()).toBe(false)
    expect(ran).toEqual(["first", "second"])
    expect(StartupHold.release()).toBe(false)
    expect(ran).toEqual(["first", "second"])
  })
})

describe("free models under a first run's hold", () => {
  test("fetch nothing while it holds, then list the catalog and the user's own key's models without a restart", async () => {
    StartupHold.useTestHold(true)
    const requests: string[] = []
    const client = FreeModels.createClient({
      hold: StartupHold,
      now: () => fixture.capturedAt,
      request: async (url) => {
        requests.push(url)
        if (url === FreeModels.CATALOG_URL) return Response.json(catalog)
        if (url.endsWith("/models/user")) return Response.json({ data: fixture.models })
        const id = endpointsPath(url)
        if (id && fixture.endpoints[id]) return Response.json({ data: { id, endpoints: fixture.endpoints[id] } })
        throw new Error("Only catalog metadata may be requested")
      },
    })
    const heard: (typeof catalog)[] = []
    client.subscribe((value) => void heard.push(value as typeof catalog))
    // Held: the first answer is OFF and nothing reached vectordev.ai or OpenRouter.
    expect(await client.catalog()).toMatchObject({ enabled: false })
    expect(await client.forKey("fixture-placeholder")).toEqual([])
    expect(requests).toEqual([])
    // The person chose how to run models (signed in to Vector, say): the catalog is read now and every listener
    // hears it, so the provider list is built again in this engine.
    StartupHold.release()
    while (heard.length === 0) await settle()
    expect(requests[0]).toBe(FreeModels.CATALOG_URL)
    expect(heard).toEqual([catalog])
    expect(await client.catalog()).toEqual(catalog)
    expect((await client.forKey("fixture-placeholder")).length).toBeGreaterThan(0)
  })

  test("tell their listeners once after the hold, even when the catalog read then did not change", async () => {
    StartupHold.useTestHold(true)
    const off = { enabled: false, updatedAt: 0, models: [] }
    const client = FreeModels.createClient({ hold: StartupHold, request: async () => Response.json(off) })
    const heard: unknown[] = []
    client.subscribe((value) => void heard.push(value))
    expect(await client.catalog()).toEqual(off)
    StartupHold.release()
    while (heard.length === 0) await settle()
    await settle()
    expect(heard).toEqual([off])
  })

  test("a client that started without a hold reads the catalog at once and never again on a release", async () => {
    const requests: string[] = []
    const client = FreeModels.createClient({
      hold: StartupHold,
      request: async (url) => {
        requests.push(url)
        return Response.json(catalog)
      },
    })
    expect(await client.catalog(true)).toEqual(catalog)
    StartupHold.release()
    await settle()
    expect(requests).toEqual([FreeModels.CATALOG_URL])
  })
})
