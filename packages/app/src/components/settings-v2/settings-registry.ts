import type { IconProps } from "@opencode-ai/ui/icon"
import type { SettingsSection } from "./general"

export type SettingsTab =
  | SettingsSection
  | "providers"
  | "models"
  | "servers"
  | "usage"
  | "billing"
  | "about"
  | "voice"
  | "personalization"
  | "rules"
  | "subagents"

export type SettingsItem = {
  value: SettingsTab
  label: string
  icon: IconProps["name"]
  keywords: readonly string[]
}

export type SettingsGroup = {
  title: string
  items: readonly SettingsItem[]
}

export const settingsGroups: readonly SettingsGroup[] = [
  {
    title: "Personal",
    items: [
      {
        value: "general",
        label: "General",
        icon: "sliders",
        keywords: ["data", "memory", "judge", "routing", "diagnostics"],
      },
      {
        value: "usage",
        label: "Usage & streak",
        icon: "status",
        keywords: ["tokens", "cost", "activity", "economics"],
      },
      {
        value: "billing",
        label: "Account & billing",
        icon: "shield",
        keywords: ["license", "plan", "subscription", "account"],
      },
      {
        value: "appearance",
        label: "Appearance",
        icon: "photo",
        keywords: ["theme", "font", "color", "density", "motion"],
      },
      { value: "voice", label: "Voice", icon: "comment", keywords: ["speech", "microphone", "audio"] },
      {
        value: "personalization",
        label: "Personalization",
        icon: "brain",
        keywords: ["profile", "memory", "instructions"],
      },
    ],
  },
  {
    title: "Agents & environment",
    items: [
      {
        value: "subagents",
        label: "Agents",
        icon: "task",
        keywords: ["subagent", "parallel", "delegation", "runtime"],
      },
      {
        value: "providers",
        label: "Providers & keys",
        icon: "providers",
        keywords: ["api", "byok", "anthropic", "openai", "credentials"],
      },
      { value: "models", label: "Default models", icon: "models", keywords: ["llm", "model picker", "routing"] },
      {
        value: "servers",
        label: "Environment & servers",
        icon: "server",
        keywords: ["mcp", "connection", "local", "remote"],
      },
    ],
  },
  {
    title: "Workspace",
    items: [
      { value: "rules", label: "Project rules", icon: "shield", keywords: ["repository", "instructions", "paths"] },
      { value: "editor", label: "Editor", icon: "code", keywords: ["font", "wrap", "autocomplete", "line numbers"] },
      { value: "chat", label: "Chat", icon: "bubble-5", keywords: ["composer", "conversation", "spacing", "width"] },
      { value: "notifications", label: "Notifications", icon: "status", keywords: ["alerts", "sound", "completion"] },
      {
        value: "accessibility",
        label: "Accessibility",
        icon: "glasses",
        keywords: ["contrast", "scale", "focus", "motion"],
      },
    ],
  },
  {
    title: "More",
    items: [
      {
        value: "about",
        label: "Updates & about",
        icon: "download",
        keywords: ["version", "update", "restart", "license", "privacy"],
      },
    ],
  },
] as const

export function filterSettingsGroups(query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return settingsGroups

  return settingsGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        [group.title, item.label, item.value, ...item.keywords].some((text) =>
          text.toLocaleLowerCase().includes(normalized),
        ),
      ),
    }))
    .filter((group) => group.items.length > 0)
}

export function settingsItemCount(groups: readonly SettingsGroup[]) {
  return groups.reduce((total, group) => total + group.items.length, 0)
}

export function isSettingsTab(value: string): value is SettingsTab {
  return settingsGroups.some((group) => group.items.some((item) => item.value === value))
}
