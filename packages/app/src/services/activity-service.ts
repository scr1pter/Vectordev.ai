import {
  getEngineeringEvents,
  logEngineeringEvent,
  type EngineeringTimelineEvent,
} from "@/utils/engineering-timeline"

export type ActivityItem = EngineeringTimelineEvent & {
  icon: string
  description: string
}

export type ActivityEventInput = Partial<EngineeringTimelineEvent> & {
  projectId?: string
}

const ACTIVITY_EVENT = "vector:engineering-event"

function iconFor(type: EngineeringTimelineEvent["type"]) {
  if (type === "ai") return "✦"
  if (type === "file") return "⌘"
  if (type === "terminal") return "›"
  if (type === "browser") return "◉"
  if (type === "checkpoint") return "✓"
  if (type === "review") return "◇"
  if (type === "error") return "!"
  if (type === "build") return "▣"
  return "◆"
}

export function toActivityItem(event: EngineeringTimelineEvent): ActivityItem {
  return {
    ...event,
    icon: iconFor(event.type),
    description: event.summary || event.source || event.title,
  }
}

export function getActivityItems(projectIds: string[], limit = 24) {
  const ids = [...new Set(projectIds.filter(Boolean))]
  return ids
    .flatMap((projectId) => getEngineeringEvents(projectId))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map(toActivityItem)
}

export function logActivity(projectId: string, input: Omit<EngineeringTimelineEvent, "id" | "timestamp"> & Partial<Pick<EngineeringTimelineEvent, "id" | "timestamp">>) {
  return logEngineeringEvent(projectId, input)
}

export function installActivityEventBridge(projectId: () => string | undefined) {
  if (typeof window === "undefined") return () => {}

  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ActivityEventInput | undefined>).detail
    if (!detail?.title || !detail.type || !detail.status) return
    const targetProject = detail.projectId || projectId() || "default"
    logEngineeringEvent(targetProject, {
      id: detail.id,
      timestamp: detail.timestamp,
      type: detail.type,
      status: detail.status,
      title: detail.title,
      summary: detail.summary,
      details: detail.details,
      files: detail.files,
      command: detail.command,
      output: detail.output,
      browserAction: detail.browserAction,
      screenshotPath: detail.screenshotPath,
      checkpointId: detail.checkpointId,
      source: detail.source,
    })
  }

  window.addEventListener(ACTIVITY_EVENT, handler)
  return () => window.removeEventListener(ACTIVITY_EVENT, handler)
}

export const activityService = {
  getActivityItems,
  installActivityEventBridge,
  logActivity,
  toActivityItem,
}
