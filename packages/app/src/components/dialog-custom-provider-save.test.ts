import { describe, expect, test } from "bun:test"
import { createVectorClient, type Config } from "@vectordevai/sdk/v2/client"
import { saveCustomProvider } from "./dialog-custom-provider-save"
import { validateCustomProvider } from "./dialog-custom-provider-form"

function fixture(
  input: {
    all?: readonly { id: string }[]
    connected?: readonly string[]
    config?: Config
    exists?: boolean
    saveStatus?: number
  } = {},
) {
  const requests: Request[] = []
  const updates: Config[] = []
  const client = createVectorClient({
    baseUrl: "http://fixture.test",
    fetch: Object.assign(
      async (source: RequestInfo | URL, init?: RequestInit) => {
        const request = source instanceof Request ? source : new Request(source, init)
        requests.push(request)
        const pathname = new URL(request.url).pathname
        if (pathname === "/provider")
          return Response.json({ all: input.all ?? [], connected: input.connected ?? [], default: {} })
        if (pathname === "/config") return Response.json(input.config ?? {})
        if (pathname.startsWith("/auth/") && request.method === "GET") return Response.json(input.exists ?? false)
        if (pathname.startsWith("/auth/") && request.method === "PUT") {
          return input.saveStatus === 409
            ? Response.json({ name: "ConflictError", message: "A credential already exists" }, { status: 409 })
            : Response.json(true)
        }
        throw new Error(`Unexpected request: ${request.method} ${pathname}`)
      },
      { preconnect() {} },
    ),
  })
  const result = validateCustomProvider({
    form: {
      providerID: "ollama",
      name: "Local provider",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "fixture-only",
      models: [{ row: "m0", id: "local-model", name: "Local model", err: {} }],
      headers: [],
      err: {},
    },
    t: (key) => key,
  }).result!
  return {
    requests,
    updates,
    result,
    save: (key: string | undefined = result.key) =>
      saveCustomProvider({
        client,
        result: { ...result, key },
        directory: "/fixture/project",
        conflictMessage: "Choose a different ID",
        updateConfig: async (config) => {
          updates.push(config)
        },
      }),
  }
}

describe("saveCustomProvider", () => {
  test("checks fresh state and saves a new custom provider with create-only credentials", async () => {
    const current = fixture()
    await current.save()
    const saved = current.requests.find((request) => request.method === "PUT")!
    expect(new URL(saved.url).searchParams.get("ifAbsent")).toBe("true")
    expect(await saved.json()).toEqual({ type: "api", key: "fixture-only" })
    expect(current.updates).toEqual([{ provider: { ollama: current.result.config } }])
    expect(
      current.requests
        .filter((request) => ["/provider", "/config"].includes(new URL(request.url).pathname))
        .every((request) => new URL(request.url).searchParams.get("directory") === "/fixture/project"),
    ).toBe(true)
  })

  test.each([
    { all: [{ id: "ollama" }] },
    { connected: ["ollama"] },
    { config: { provider: { ollama: { name: "Existing" } } } },
    { config: { disabled_providers: ["ollama"] } },
    { exists: true },
  ])("refuses a provider that appeared after the form was validated: %j", async (input) => {
    const current = fixture({ ...input, config: input.config ? (structuredClone(input.config) as Config) : undefined })
    await expect(current.save()).rejects.toThrow("Choose a different ID")
    expect(current.requests.filter((request) => request.method !== "GET")).toEqual([])
    expect(current.updates).toEqual([])
  })

  test("does not attach an orphan saved credential when no key is entered", async () => {
    const current = fixture({ exists: true })
    await expect(current.save("")).rejects.toThrow("Choose a different ID")
    expect(current.updates).toEqual([])
  })

  test("does not change config when another client saves the credential first", async () => {
    const current = fixture({ saveStatus: 409 })
    await expect(current.save()).rejects.toThrow("Choose a different ID")
    expect(current.updates).toEqual([])
  })

  test("allows a new provider without a stored key", async () => {
    const current = fixture()
    await current.save("")
    expect(current.requests.filter((request) => request.method !== "GET")).toEqual([])
    expect(current.updates).toHaveLength(1)
  })
})
