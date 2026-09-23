import { expect, test } from "bun:test"
import { createVectorClient } from "../src/client"

test("regenerated V1 preserves grouped id, query, and body call signatures", async () => {
  const requests: { method: string; url: string; body?: unknown }[] = []
  const client = createVectorClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      requests.push({ method: request.method, url: request.url, body: request.body ? await request.json() : undefined })
      return Response.json({})
    },
  })
  await client.auth.set({ path: { id: "fixture" }, body: { type: "api", key: "test-only" } })
  await client.session.get({ path: { id: "ses_fixture" }, query: { directory: "/project space" } })
  await client.session.prompt({
    path: { id: "ses_fixture" },
    body: { noReply: true, parts: [{ type: "text", text: "fixture" }] },
  })
  await client.pty.get({ path: { id: "pty_fixture" } })
  await client.postSessionIdPermissionsPermissionId({
    path: { id: "ses_fixture", permissionID: "per_fixture" },
    body: { response: "reject" },
  })
  expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
    ["PUT", "/auth/fixture"],
    ["GET", "/session/ses_fixture"],
    ["POST", "/session/ses_fixture/message"],
    ["GET", "/pty/pty_fixture"],
    ["POST", "/session/ses_fixture/permissions/per_fixture"],
  ])
  expect(new URL(requests[1].url).searchParams.get("directory")).toBe("/project space")
  expect(requests[2].body).toEqual({ noReply: true, parts: [{ type: "text", text: "fixture" }] })
})
