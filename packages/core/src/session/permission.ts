import type { Permission } from "@vectordevai/schema/permission"
import { reviewPermissionRules } from "../review/permission"

// Hidden planning sessions cannot ask questions or mutate the project, even when
// the selected agent has broader user-configured permissions.
export function internalSessionPermissions(internal?: string | null): Permission.Ruleset {
  if (internal !== "swarm.planner") return []
  return reviewPermissionRules({}).map((rule) => ({
    action: rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }))
}
