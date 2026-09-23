import { expect, test } from "bun:test"
import { v1Schema } from "../script/v1-schema"

test("V1 transport mapping preserves existing id calls and leaves V2 routes unchanged", () => {
  const document = {
    paths: {
      "/session/{sessionID}/permissions/{permissionID}": {
        post: {
          operationId: "permission.respond",
          parameters: [
            { in: "path", name: "sessionID" },
            { in: "path", name: "permissionID" },
            { in: "query", name: "sessionID" },
          ],
        },
      },
      "/api/session/{sessionID}": { get: { parameters: [{ in: "path", name: "sessionID" }] } },
    },
  }
  const result = v1Schema(document)
  expect(result.paths).toEqual({
    "/session/{id}/permissions/{permissionID}": {
      post: {
        operationId: "postSessionIdPermissionsPermissionId",
        parameters: [
          { in: "path", name: "id" },
          { in: "path", name: "permissionID" },
          { in: "query", name: "sessionID" },
        ],
      },
    },
    "/api/session/{sessionID}": document.paths["/api/session/{sessionID}"],
  })
  expect(document.paths["/session/{sessionID}/permissions/{permissionID}"].post.parameters[0].name).toBe("sessionID")
})
