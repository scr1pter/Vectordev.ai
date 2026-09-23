import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@vectordevai/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~vector/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~vector/WorkspaceRef", {
  defaultValue: () => undefined,
})
