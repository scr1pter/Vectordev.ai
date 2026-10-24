import { expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { requireLocalEngine } from "./engine-compatibility"
import type { DesktopLocal } from "@/utils/desktop-local"

const local = async (): Promise<DesktopLocal> => ({ enabled: true, held: false, sources: {} })
const policy = {
  enabled: true,
  web: "none",
  lock: false,
  endpoints: [],
  web_domains: { allow: [], deny: [] },
  allow: [],
  user_may: [],
  locked_keys: [],
  endpoint_domains: [],
  warnings: [],
}

test("asks the actual destination engine and refuses absent, malformed or disabled Local protection", async () => {
  const state: { body: unknown; code: number; paths: string[] } = { body: { policy }, code: 200, paths: [] }
  const client = createVectorClient({
    baseUrl: "http://actual-destination.test",
    throwOnError: true,
    fetch: async (request) => {
      state.paths.push(request instanceof Request ? request.url : String(request))
      if (state.code === 0) throw new Error("offline")
      return Response.json(state.body, { status: state.code })
    },
  })
  await requireLocalEngine(client, local)
  expect(state.paths).toEqual(["http://actual-destination.test/local"])
  for (const body of [
    undefined,
    {},
    { policy: { enabled: true } },
    { policy: { ...policy, enabled: false } },
    { policy: { ...policy, pending: true } },
  ]) {
    state.body = body ?? null
    await expect(requireLocalEngine(client, local)).rejects.toThrow("could not confirm protection")
  }
  state.body = { policy }
  for (const code of [401, 403, 404, 500]) {
    state.code = code
    await expect(requireLocalEngine(client, local)).rejects.toThrow("could not confirm protection")
  }
  state.code = 0
  await expect(requireLocalEngine(client, local)).rejects.toThrow("could not confirm protection")
})

test("makes no compatibility request outside desktop Local, and refuses an unreadable or held desktop policy", async () => {
  let requested = false
  const client = createVectorClient({
    baseUrl: "http://unused.invalid",
    fetch: async () => {
      requested = true
      throw new Error("unexpected request")
    },
  })
  await requireLocalEngine(client, async () => undefined)
  await requireLocalEngine(client, async () => ({ ...(await local()), enabled: false }))
  await expect(
    requireLocalEngine(client, async () => {
      throw new Error("bridge unavailable")
    }),
  ).rejects.toThrow("could not confirm protection")
  await expect(requireLocalEngine(client, async () => ({ ...(await local()), held: true }))).rejects.toThrow(
    "Finish choosing",
  )
  expect(requested).toBe(false)
})
