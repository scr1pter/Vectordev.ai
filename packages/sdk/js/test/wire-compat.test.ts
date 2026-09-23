import { describe, expect, test } from "bun:test"

const legacy = await import("../src/client")
const current = await import("../src/v2/client")

for (const [name, sdk] of [
  ["v1", legacy],
  ["v2", current],
] as const) {
  describe(`${name} Vector wire compatibility`, () => {
    test("retains the upstream factory alias", () => {
      expect(sdk.createVectorClient).toBe(sdk.createOpencodeClient)
    })

    for (const header of ["x-vector-directory", "x-opencode-directory"]) {
      test(`decodes ${header} once when moving it into a GET query`, async () => {
        const requests: Request[] = []
        const directory = "/tmp/Vector project/東京/%20"
        const client = sdk.createVectorClient({
          baseUrl: "http://localhost",
          headers: { [header]: encodeURIComponent(directory) },
          fetch: async (request) => {
            requests.push(request)
            return Response.json([])
          },
        })
        await client.session.list()
        expect(new URL(requests[0].url).searchParams.get("directory")).toBe(directory)
        expect(requests[0].headers.has("x-vector-directory")).toBe(false)
        expect(requests[0].headers.has("x-opencode-directory")).toBe(false)
      })
    }

    test("prefers Vector directory headers and emits both names for writes", async () => {
      const requests: Request[] = []
      const capture = async (request: Request) => {
        requests.push(request)
        return Response.json({})
      }
      await sdk
        .createVectorClient({
          baseUrl: "http://localhost",
          headers: { "x-vector-directory": "/vector", "x-opencode-directory": "/legacy" },
          fetch: capture,
        })
        .session.list()
      expect(new URL(requests[0].url).searchParams.get("directory")).toBe("/vector")
      await sdk
        .createVectorClient({ baseUrl: "http://localhost", directory: "/write space", fetch: capture })
        .session.create()
      expect(requests[1].method).toBe("POST")
      expect(requests[1].headers.get("x-vector-directory")).toBe(encodeURIComponent("/write space"))
      expect(requests[1].headers.get("x-opencode-directory")).toBe(encodeURIComponent("/write space"))
    })

    test("falls back to the legacy header when the Vector header is empty", async () => {
      const requests: Request[] = []
      await sdk
        .createVectorClient({
          baseUrl: "http://localhost",
          headers: { "x-vector-directory": "", "x-opencode-directory": "/legacy" },
          fetch: async (request) => {
            requests.push(request)
            return Response.json([])
          },
        })
        .session.list()
      expect(new URL(requests[0].url).searchParams.get("directory")).toBe("/legacy")
    })
  })
}

for (const prefix of ["vector", "opencode"]) {
  test(`v2 migrates ${prefix} workspace headers into location queries`, async () => {
    const requests: Request[] = []
    const client = current.createVectorClient({
      baseUrl: "http://localhost",
      headers: {
        [`x-${prefix}-directory`]: encodeURIComponent("/tmp/project space"),
        [`x-${prefix}-workspace`]: "wrk_selected",
      },
      fetch: async (request) => {
        requests.push(request)
        return Response.json({})
      },
    })
    await client.v2.command.list()
    const query = new URL(requests[0].url).searchParams
    expect(query.get("location[directory]")).toBe("/tmp/project space")
    expect(query.get("location[workspace]")).toBe("wrk_selected")
    expect(requests[0].headers.has(`x-${prefix}-workspace`)).toBe(false)
  })
}

test("v2 explicit query selection wins over both header names", async () => {
  const requests: Request[] = []
  const client = current.createVectorClient({
    baseUrl: "http://localhost",
    headers: {
      "x-vector-directory": "/vector",
      "x-opencode-directory": "/legacy",
      "x-vector-workspace": "wrk_vector",
      "x-opencode-workspace": "wrk_legacy",
    },
    fetch: async (request) => {
      requests.push(request)
      return Response.json([])
    },
  })
  await client.session.list({ directory: "/query", workspace: "wrk_query" })
  const query = new URL(requests[0].url).searchParams
  expect(query.get("directory")).toBe("/query")
  expect(query.get("workspace")).toBe("wrk_query")
  await client.v2.command.list({ location: { directory: "/location", workspace: "wrk_location" } })
  const location = new URL(requests[1].url).searchParams
  expect(location.get("location[directory]")).toBe("/location")
  expect(location.get("location[workspace]")).toBe("wrk_location")
})

test("v1 preserves workspace headers when converting directory headers", async () => {
  const requests: Request[] = []
  await legacy
    .createVectorClient({
      baseUrl: "http://localhost",
      directory: "/project",
      headers: { "x-vector-workspace": "wrk_selected", "x-opencode-workspace": "wrk_selected" },
      fetch: async (request) => {
        requests.push(request)
        return Response.json([])
      },
    })
    .session.list()
  expect(requests[0].headers.get("x-vector-workspace")).toBe("wrk_selected")
  expect(requests[0].headers.get("x-opencode-workspace")).toBe("wrk_selected")
})

test("v2 emits both workspace header names for writes", async () => {
  const requests: Request[] = []
  await current
    .createVectorClient({
      baseUrl: "http://localhost",
      experimental_workspaceID: "wrk_selected",
      fetch: async (request) => {
        requests.push(request)
        return Response.json({})
      },
    })
    .session.create()
  expect(requests[0].method).toBe("POST")
  expect(requests[0].headers.get("x-vector-workspace")).toBe("wrk_selected")
  expect(requests[0].headers.get("x-opencode-workspace")).toBe("wrk_selected")
})
