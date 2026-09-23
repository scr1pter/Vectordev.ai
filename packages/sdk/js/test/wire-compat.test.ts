import { describe, expect, test } from "bun:test"

const v1 = await import("../src/client")
const v2 = await import("../src/v2/client")

for (const [name, sdk] of [
  ["v1", v1],
  ["v2", v2],
] as const) {
  describe(`${name} Vector wire protocol`, () => {
    test("exports Vector factories and client classes", () => {
      expect(Object.keys(sdk).sort()).toEqual(["VectorClient", "createVectorClient"])
    })

    test("decodes directory headers once for GET queries", async () => {
      const requests: Request[] = []
      const directory = "/tmp/Vector project/東京/%20"
      await sdk
        .createVectorClient({
          baseUrl: "http://localhost",
          headers: { "x-vector-directory": encodeURIComponent(directory) },
          fetch: async (request) => {
            requests.push(request)
            return Response.json([])
          },
        })
        .session.list()
      expect(new URL(requests[0].url).searchParams.get("directory")).toBe(directory)
      expect(requests[0].headers.has("x-vector-directory")).toBe(false)
    })

    test("sends encoded Vector directory headers for writes", async () => {
      const requests: Request[] = []
      await sdk
        .createVectorClient({
          baseUrl: "http://localhost",
          directory: "/write space",
          fetch: async (request) => {
            requests.push(request)
            return Response.json({})
          },
        })
        .session.create()
      expect(requests[0].method).toBe("POST")
      expect(requests[0].headers.get("x-vector-directory")).toBe(encodeURIComponent("/write space"))
    })
  })
}

test("V2 maps Vector directory/workspace headers to location queries", async () => {
  const requests: Request[] = []
  await v2
    .createVectorClient({
      baseUrl: "http://localhost",
      headers: { "x-vector-directory": encodeURIComponent("/tmp/project space"), "x-vector-workspace": "wrk_selected" },
      fetch: async (request) => {
        requests.push(request)
        return Response.json({})
      },
    })
    .v2.command.list()
  const query = new URL(requests[0].url).searchParams
  expect(query.get("location[directory]")).toBe("/tmp/project space")
  expect(query.get("location[workspace]")).toBe("wrk_selected")
  expect(requests[0].headers.has("x-vector-workspace")).toBe(false)
})

test("V2 explicit query selection wins over headers", async () => {
  const requests: Request[] = []
  const client = v2.createVectorClient({
    baseUrl: "http://localhost",
    headers: { "x-vector-directory": "/header", "x-vector-workspace": "wrk_header" },
    fetch: async (request) => {
      requests.push(request)
      return Response.json([])
    },
  })
  await client.session.list({ directory: "/query", workspace: "wrk_query" })
  expect(new URL(requests[0].url).searchParams.get("directory")).toBe("/query")
  expect(new URL(requests[0].url).searchParams.get("workspace")).toBe("wrk_query")
  await client.v2.command.list({ location: { directory: "/location", workspace: "wrk_location" } })
  expect(new URL(requests[1].url).searchParams.get("location[directory]")).toBe("/location")
  expect(new URL(requests[1].url).searchParams.get("location[workspace]")).toBe("wrk_location")
})

test("V1 preserves workspace selection when converting directory headers", async () => {
  const requests: Request[] = []
  await v1
    .createVectorClient({
      baseUrl: "http://localhost",
      directory: "/project",
      headers: { "x-vector-workspace": "wrk_selected" },
      fetch: async (request) => {
        requests.push(request)
        return Response.json([])
      },
    })
    .session.list()
  expect(requests[0].headers.get("x-vector-workspace")).toBe("wrk_selected")
})

test("V2 uses the Vector workspace header for writes", async () => {
  const requests: Request[] = []
  await v2
    .createVectorClient({
      baseUrl: "http://localhost",
      experimental_workspaceID: "wrk_selected",
      fetch: async (request) => {
        requests.push(request)
        return Response.json({})
      },
    })
    .session.create()
  expect(requests[0].headers.get("x-vector-workspace")).toBe("wrk_selected")
})
