import { expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2/client"
import { saveCustomProviderCredential } from "../../../../src/component/custom-provider-credential"

function fixture(input: { configured?: boolean; exists?: boolean; conflict?: boolean } = {}) {
  const requests: Request[] = []
  const client = createVectorClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      async (source: RequestInfo | URL, init?: RequestInit) => {
        const request = source instanceof Request ? source : new Request(source, init)
        requests.push(request)
        const pathname = new URL(request.url).pathname
        if (pathname === "/provider") return Response.json({ all: [], connected: [], default: {} })
        if (pathname === "/config")
          return Response.json(
            input.configured ? { provider: { myprovider: {} }, disabled_providers: ["myprovider"] } : {},
          )
        if (request.method === "GET") return Response.json(input.exists ?? false)
        if (input.conflict)
          return Response.json({ name: "ConflictError", message: "Credential exists" }, { status: 409 })
        return Response.json(true)
      },
      { preconnect() {} },
    ),
  })
  return { client, requests }
}

test("Other stores only a fresh custom provider credential with create-only semantics", async () => {
  const current = fixture()
  await saveCustomProviderCredential(current.client, "myprovider", "fixture-only")
  const saved = current.requests.find((request) => request.method === "PUT")!
  expect(new URL(saved.url).searchParams.get("ifAbsent")).toBe("true")
  expect(await saved.json()).toEqual({ type: "api", key: "fixture-only" })
})

test.each([{ configured: true }, { exists: true }])(
  "Other refuses a configured or orphan credential ID: %j",
  async (input) => {
    const current = fixture(input)
    await expect(saveCustomProviderCredential(current.client, "myprovider", "fixture-only")).rejects.toThrow(
      "already exists",
    )
    expect(current.requests.filter((request) => request.method !== "GET")).toEqual([])
  },
)

test("Other refuses built-in provider IDs without replacing their key", async () => {
  const current = fixture()
  await expect(saveCustomProviderCredential(current.client, "openai", "fixture-only")).rejects.toThrow("already exists")
  expect(current.requests.filter((request) => request.method !== "GET")).toEqual([])
})

test("Other surfaces an atomic create conflict instead of reporting success", async () => {
  const current = fixture({ conflict: true })
  await expect(saveCustomProviderCredential(current.client, "myprovider", "fixture-only")).rejects.toThrow(
    "already exists",
  )
})
