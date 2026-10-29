export * as ComputerOnboarding from "./onboarding-model"

import type { Computer } from "@vectordevai/schema/computer"
import type { dict } from "../../i18n/en"

export type Platform = "macos" | "windows"
export type Step = "consent" | "permissions" | "try"
export type CopyKey = Extract<
  keyof typeof dict,
  `computer.onboarding.${string}` | "computer.availability.elevated" | "computer.status.preview"
>
export type StepDescriptor = { id: Step; title: CopyKey; description: CopyKey[] }
type Permission = Computer.PermissionsView["rows"][number]["id"]
type Status = Computer.PermissionsView["rows"][number]["status"]
export type Row = {
  id: string
  title: CopyKey
  description?: CopyKey
  status?: Status
  open?: Permission | "windows-capture"
  reset?: Permission
}

/** Steps describe the wizard only. Advancing never enables the feature or grants an OS permission. */
export function steps(platform: Platform, permissions?: Computer.PermissionsView): StepDescriptor[] {
  const consent: StepDescriptor = {
    id: "consent",
    title: "computer.onboarding.title",
    description: [
      "computer.onboarding.description",
      "computer.onboarding.indicators",
      "computer.onboarding.screenPrivacy",
      "computer.onboarding.limits",
      ...(platform === "windows" ? ["computer.onboarding.windows.description" as const] : []),
      ...(platform === "macos" && permissions?.adhoc === true ? ["computer.onboarding.preview" as const] : []),
    ],
  }
  const permission: StepDescriptor = {
    id: "permissions",
    title: "computer.onboarding.permissions",
    description: [
      platform === "macos" ? "computer.onboarding.macos.instruction" : "computer.onboarding.windows.description",
    ],
  }
  const trial: StepDescriptor = { id: "try", title: "computer.onboarding.tryIt", description: [] }
  return platform === "windows" && permissions?.windows && ready(permissions)
    ? [consent, trial]
    : [consent, permission, trial]
}

/** Call after the consent click is persisted; Finish still independently requires that consent. */
export function next(step: Step, permissions?: Computer.PermissionsView): Step {
  if (step === "consent") return permissions?.windows && ready(permissions) ? "try" : "permissions"
  return ready(permissions) ? "try" : "permissions"
}

/** Only fixed pane IDs leave this projection. A provider's pane URL is never used as an action. */
export function rowsFor(
  permissions: Computer.PermissionsView | undefined,
  prefs: Pick<Computer.ComputerPrefs, "granted">,
): Row[] {
  if (!permissions) return []
  const rows: Row[] = []
  if (permissions.helperStart === "failed") rows.push({ id: "helper", title: "computer.onboarding.helperFailed" })
  if (permissions.windows !== undefined) {
    if (permissions.windows?.captureBlocked === true)
      rows.push({
        id: "windows-capture",
        title: "computer.onboarding.windows.captureBlocked",
        open: "windows-capture",
      })
    if (permissions.windows?.elevated === true)
      rows.push({ id: "windows-elevated", title: "computer.availability.elevated" })
    return rows
  }
  for (const id of ["screen", "accessibility"] as const) {
    const status = permissionStatus(permissions, id)
    const title =
      id === "screen" ? "computer.onboarding.macos.screenRecording" : "computer.onboarding.macos.accessibility"
    rows.push({
      id,
      title,
      description:
        id === "screen"
          ? "computer.onboarding.macos.screenRecording.description"
          : "computer.onboarding.macos.accessibility.description",
      status,
      open: id,
    })
    if (
      status === "reset-after-update" ||
      (status === "denied" && typeof prefs.granted?.helperVersion === "string" && prefs.granted.helperVersion.trim())
    )
      rows.push({
        id: `reset-${id}`,
        title,
        description: "computer.onboarding.macos.grantReset",
        open: id,
        ...(permissions.canReset === true ? { reset: id } : {}),
      })
    if (permissions.vectorHoldsGrant?.[id] === true)
      rows.push({ id: `main-${id}`, title, description: "computer.onboarding.macos.mainAppGrant", open: id })
  }
  if (permissions.adhoc === true)
    rows.push({ id: "preview", title: "computer.status.preview", description: "computer.onboarding.preview" })
  rows.push({ id: "recording-reminder", title: "computer.onboarding.macos.recordingReminder" })
  return rows
}

/** Consent is an explicit timestamp, not a preference default. The dialog also freshly checks status and policy. */
export function canFinish(permissions: Computer.PermissionsView | undefined, consentedAt?: number): boolean {
  return typeof consentedAt === "number" && Number.isSafeInteger(consentedAt) && consentedAt > 0 && ready(permissions)
}

function ready(permissions: Computer.PermissionsView | undefined): boolean {
  if (permissions?.helperStart !== "ok") return false
  if (permissions.windows !== undefined)
    return (
      Array.isArray(permissions.rows) &&
      permissions.rows.length === 0 &&
      permissions.windows?.captureBlocked === false &&
      permissions.windows?.elevated === false
    )
  if (!Array.isArray(permissions.rows) || permissions.rows.length !== 2) return false
  return (
    permissionStatus(permissions, "screen") === "granted" &&
    permissionStatus(permissions, "accessibility") === "granted"
  )
}

function permissionStatus(permissions: Computer.PermissionsView, id: Permission): Status {
  const matches = Array.isArray(permissions.rows) ? permissions.rows.filter((row) => row?.id === id) : []
  if (matches.length !== 1) return "unknown"
  const status = matches[0].status
  return status === "granted" || status === "denied" || status === "reset-after-update" ? status : "unknown"
}
