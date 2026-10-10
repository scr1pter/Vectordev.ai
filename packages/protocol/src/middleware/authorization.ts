import { Context } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { ForbiddenError, UnauthorizedError } from "../errors"

export type Principal =
  | { readonly kind: "owner"; readonly username: string }
  | {
      readonly kind: "guest"
      readonly username: string
      readonly workspaceIDs: ReadonlySet<string>
      readonly sessionIDs: ReadonlySet<string>
    }

export const RequestPrincipal = Context.Reference<Principal>("@vector/RequestPrincipal", {
  defaultValue: () => ({ kind: "owner", username: "vector" }),
})

export function allowsWorkspace(principal: Principal, workspaceID: string | undefined) {
  return principal.kind === "owner" || (workspaceID !== undefined && principal.workspaceIDs.has(workspaceID))
}

export function allowsSession(principal: Principal, sessionID: string) {
  return principal.kind === "owner" || principal.sessionIDs.has(sessionID)
}

export class Authorization extends HttpApiMiddleware.Service<Authorization>()("@vector/HttpApiAuthorization", {
  error: [UnauthorizedError, ForbiddenError],
}) {}
