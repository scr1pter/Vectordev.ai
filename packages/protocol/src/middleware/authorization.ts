import { Context } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import type { Pty } from "@vectordevai/schema/pty"
import { ForbiddenError, UnauthorizedError } from "../errors"

export type Principal =
  | { readonly kind: "owner"; readonly username: string }
  | {
      readonly kind: "pty-ticket"
      readonly username: string
      readonly ptyID: Pty.ID
      readonly ticket: string
    }
  | {
      readonly kind: "guest"
      readonly username: string
      readonly workspaceIDs: ReadonlySet<string>
      readonly workspaceDirectories: ReadonlyMap<string, string>
      readonly sessionIDs: ReadonlySet<string>
    }

export const RequestPrincipal = Context.Reference<Principal>("@vector/RequestPrincipal", {
  defaultValue: () => ({ kind: "owner", username: "vector" }),
})

export function allowsWorkspace(principal: Principal, workspaceID: string | undefined) {
  return (
    principal.kind === "owner" ||
    (principal.kind === "guest" && workspaceID !== undefined && principal.workspaceIDs.has(workspaceID))
  )
}

export function guestWorkspaceDirectory(principal: Principal, workspaceID: string | undefined): string | undefined {
  if (principal.kind !== "guest" || workspaceID === undefined || !principal.workspaceIDs.has(workspaceID)) return
  return principal.workspaceDirectories.get(workspaceID)
}

export function allowsSession(principal: Principal, sessionID: string) {
  return principal.kind === "owner" || (principal.kind === "guest" && principal.sessionIDs.has(sessionID))
}

export class Authorization extends HttpApiMiddleware.Service<Authorization>()("@vector/HttpApiAuthorization", {
  error: [UnauthorizedError, ForbiddenError],
}) {}
