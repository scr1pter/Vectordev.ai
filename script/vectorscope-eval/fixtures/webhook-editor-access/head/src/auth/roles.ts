export type Role = "viewer" | "editor" | "admin" | "owner"

export interface Member {
  userId: string
  workspaceId: string
  role: Role
}

export class ForbiddenError extends Error {
  readonly status = 403
}

// Each role can do everything the roles ranked below it can.
const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
}

export function hasRole(member: Member, minimum: Role) {
  return ROLE_RANK[minimum] >= ROLE_RANK[member.role]
}

export function requireRole(member: Member | undefined, minimum: Role): Member {
  if (!member || !hasRole(member, minimum)) throw new ForbiddenError(`This action needs the ${minimum} role`)
  return member
}

export function isAdmin(member: Member) {
  return hasRole(member, "admin")
}

export function requireAdmin(member: Member | undefined): Member {
  return requireRole(member, "admin")
}
