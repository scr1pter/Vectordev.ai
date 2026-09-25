import { expect, test } from "bun:test"
import { SCHEMA_PATHS, verifyDeployedSchemas } from "../../../script/verify-deployed-schemas"

test("checks all deployed schema routes and rejects an HTML fallback or missing route", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/theme.json") return Response.json({ $schema: "https://json-schema.org/draft/2020-12/schema" })
      if (path === "/config.json")
        return new Response("<html>fallback</html>", { headers: { "content-type": "text/html" } })
      return new Response("missing", { status: 404 })
    },
  })
  try {
    await expect(verifyDeployedSchemas(server.url.toString())).rejects.toThrow()
  } finally {
    server.stop(true)
  }
  const healthy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return Response.json({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" })
    },
  })
  try {
    expect((await verifyDeployedSchemas(healthy.url.toString())).map((item) => item.path)).toEqual([...SCHEMA_PATHS])
  } finally {
    healthy.stop(true)
  }
})
