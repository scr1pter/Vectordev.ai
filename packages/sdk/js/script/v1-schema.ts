/** Keep grouped SDK callers' path.id options while generating from the current API. */
export function v1Schema(document: { paths?: Record<string, Record<string, unknown>>; [key: string]: unknown }) {
  const result = structuredClone(document)
  if (!result.paths) return result
  result.paths = Object.fromEntries(
    Object.entries(result.paths).map(([route, operations]) => {
      const match = route.match(/^\/(auth|provider|session|pty)\/\{(providerID|sessionID|ptyID)\}/)
      if (!match) return [route, operations]
      const next = route.replace(`{${match[2]}}`, "{id}")
      for (const operation of Object.values(operations)) {
        if (!operation || typeof operation !== "object") continue
        if ("parameters" in operation && Array.isArray(operation.parameters)) {
          for (const parameter of operation.parameters) {
            if (parameter.in === "path" && parameter.name === match[2]) parameter.name = "id"
          }
        }
        if ("operationId" in operation && operation.operationId === "permission.respond") {
          operation.operationId = "postSessionIdPermissionsPermissionId"
        }
      }
      return [next, operations]
    }),
  )
  return result
}
