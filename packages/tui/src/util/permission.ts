import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Hands } from "@vectordevai/schema/hands"
import { Computer } from "@vectordevai/schema/computer"
import { ComputerApps } from "@vectordevai/schema/computer-apps"
import { Schema } from "effect"

export const canAutoApprovePermission = PermissionPolicy.canAutoApprove
export const canAlwaysAllowPermission = PermissionPolicy.canAlwaysApprove

/** Display only verified metadata fields. Pattern keys and model-authored reasons are never titles. */
export function computerPermissionDetails(request: {
  permission: string
  metadata: Record<string, unknown>
  always?: readonly string[]
}) {
  if (!request.permission.startsWith("computer_")) return
  const target = request.metadata.target
  const fields = target && typeof target === "object" && !Array.isArray(target) ? target : undefined
  const name = computerLabel(fields && Reflect.get(fields, "appName"), 256)
  const app = name || "this app"
  const kind = request.permission === "computer_app" ? "app" : "sensitive"
  const label = computerLabel(request.metadata.targetName, 40) || "this control"
  const action = typeof request.metadata.action === "string" ? request.metadata.action : ""
  const verbs: Record<string, string> = {
    click: `click “${label}” in ${app}`,
    type: `type in ${app}`,
    key: `press a key in ${app}`,
    drag: `drag in ${app}`,
    open: "run a program",
  }
  const metadata = {
    ...request.metadata,
    ...(fields ? { target: { ...fields, appName: name } } : {}),
    ...(typeof request.metadata.targetName === "string"
      ? { targetName: computerLabel(request.metadata.targetName, 40) }
      : {}),
    ...(typeof request.metadata.reason === "string" ? { reason: computerLabel(request.metadata.reason, 200) } : {}),
  }
  const appMetadata = kind === "app" && Schema.is(Computer.AppAskMetadata)(metadata) ? metadata : undefined
  const reason =
    request.permission === "computer_sensitive" && Schema.is(Computer.SensitiveAskMetadata)(metadata)
      ? computerSensitiveReason(metadata, app)
      : undefined
  const canApprove =
    Boolean(name) &&
    (appMetadata
      ? !ComputerApps.isNever(appMetadata.target.category) &&
        Computer.parseAppKey(appMetadata.target.appKey)?.platform === appMetadata.target.platform
      : reason !== undefined)
  const verb =
    request.metadata.why === "run_program" || action === "open"
      ? "run a program"
      : request.metadata.why === "paste"
        ? `paste in ${app}`
        : verbs[action]
  const canAlways =
    appMetadata !== undefined &&
    canApprove &&
    appMetadata.canAlways &&
    appMetadata.alwaysWhyNot === undefined &&
    appMetadata.target.verified &&
    !ComputerApps.NO_ALWAYS.has(appMetadata.target.category) &&
    canAlwaysAllowPermission(request.permission, request.always) &&
    request.always?.every((key) => key === appMetadata.target.appKey) === true
  return {
    kind,
    app,
    title: !canApprove
      ? `Review ${Hands.NAME} request`
      : kind === "app"
        ? `Allow ${Hands.NAME} to use ${app}?`
        : `${Hands.NAME} wants to ${verb}`,
    body: !canApprove
      ? "This request could not be verified. Deny it and ask the agent to try again."
      : kind === "app"
        ? request.metadata.level === "observe"
          ? `It can see the windows of ${app} until this task is done.`
          : `It can see the windows of ${app} and click, type and use its menus until this task is done.`
        : `App: ${app}\n${reason}`,
    alwaysDescription: `Always allow skips this question for ${app} from now on. Remove it in Settings › ${Hands.NAME}.`,
    canAlways,
    canApprove,
    primaryLabel: kind === "app" ? "Allow" : "Allow once",
  }
}

function computerLabel(value: unknown, limit: number) {
  const text = computerText(value, limit)
  return /^(?:app:|window:\d+:\d+$)/i.test(text) ? "" : text
}

function computerText(value: unknown, limit: number) {
  if (typeof value !== "string") return ""
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "")
    .trim()
    .slice(0, limit)
    .replace(/[\ud800-\udbff]$/, "")
}

function computerSensitiveReason(metadata: Computer.SensitiveAskMetadata, app: string) {
  if (metadata.why === "run_program") {
    const path = computerText(metadata.path, 4096)
    return path ? `This runs a program: ${path}.` : undefined
  }
  if (metadata.why === "paste")
    return typeof metadata.text === "string"
      ? `This pastes what you copied: “${computerText(metadata.text, 60)}”.`
      : undefined
  if (metadata.why === "new_destination") {
    const destination = computerText(metadata.destination, 2048)
    return destination ? `It's typing an address you didn't give it: ${destination}.` : undefined
  }
  if (metadata.why === "provider_check") {
    const provider = computerText(metadata.providerCheck?.provider, 64)
    const message = computerText(metadata.providerCheck?.message, 1000)
    return provider && message
      ? `${provider} flagged this step: ${message}${metadata.providerCheck?.domain ? "\nWatch this step closely." : ""}`
      : undefined
  }
  return {
    send: "This sends a message.",
    delete: "This deletes something.",
    buy: "This may spend money.",
    submit: "This submits a form.",
    account: "This changes an account or accepts terms.",
    settings: "This changes a setting.",
    ide_run: `This runs code in ${app}.`,
    disruptive: "This quits an app or logs you out.",
    flagged: PermissionPolicy.FLAGGED_SCREEN_REASON,
  }[metadata.why]
}

export function cloudPermissionDetails(request: { permission: string; metadata: Record<string, unknown> }) {
  if (!request.permission.startsWith("vector_cloud_")) return
  const text = (key: string) => {
    const value = request.metadata[key]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }
  const rows = [
    { label: "Provider", value: text("provider") },
    {
      label: text("provider") === "Vector" ? "Repository" : `${text("provider") ?? "Cloud"} project`,
      value: text("project"),
    },
    { label: "Environment", value: text("environment") },
  ].flatMap((row) => (row.value ? [{ label: row.label, value: row.value }] : []))
  const statements = Array.isArray(request.metadata.statements)
    ? request.metadata.statements.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return []
        const label = Reflect.get(item, "label")
        const sql = Reflect.get(item, "sql")
        const length = Reflect.get(item, "length")
        if (typeof label !== "string" || typeof sql !== "string" || !sql.trim()) return []
        return [{ label, sql, incomplete: typeof length === "number" && length > sql.length }]
      })
    : []
  return { summary: text("summary"), rows, statements }
}
