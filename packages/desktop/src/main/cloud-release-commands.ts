import { basename } from "node:path"

import {
  detectBuildSettings,
  getBuildSettings,
  listDeployments,
  normalizeHealthPath,
  setBuildSettings,
  type CloudBuildSettings,
  type CloudDeployment,
  type CloudRequiredChecks,
} from "./cloud-console"
import { getCloudProviderProjectLink } from "./cloud-connections"
import { checkAllDeploymentHealth, checkDeploymentHealth, rerunDeploymentChecks } from "./publish"

// The agent's side of what Vector Cloud > Observability and > Project settings
// do with Vector's own release records: probe live releases, re-run a
// release's checks, and change the build commands and required checks Vector
// runs before it lets a release reach production. Reports are worded for the
// model in `text`.

export const RELEASE_COMMANDS = ["check_health", "rerun_checks", "set_release_settings"] as const

export type ReleaseCommand = (typeof RELEASE_COMMANDS)[number]

export type ReleaseSettingsFields = Partial<
  Pick<
    CloudBuildSettings,
    | "framework"
    | "packageManager"
    | "installCommand"
    | "testCommand"
    | "buildCommand"
    | "outputDirectory"
    | "nodeVersion"
    | "healthPath"
  >
> & { requiredChecks?: Partial<CloudRequiredChecks> }

type ReleaseInput = ReleaseSettingsFields & {
  command: string
  projectPath: string
  taskId?: string
  /** The project's working directory, which is a worktree for a parallel agent. */
  directory: string
  deploymentId?: string
}

const CHECK_LABELS: Record<keyof CloudRequiredChecks, string> = {
  test: "Tests",
  secrets: "Secret scan",
  health: "Health probe",
  browser: "Browser render",
}

const PACKAGE_MANAGERS = ["bun", "pnpm", "yarn", "npm", "static"] as const

const COMMAND_FIELDS = [
  ["framework", "framework"],
  ["packageManager", "package manager"],
  ["installCommand", "install command"],
  ["testCommand", "test command"],
  ["buildCommand", "build command"],
  ["outputDirectory", "output directory"],
  ["nodeVersion", "Node version"],
  ["healthPath", "health path"],
] as const

export function isReleaseCommand(value: unknown): value is ReleaseCommand {
  return RELEASE_COMMANDS.some((item) => item === value)
}

export function parseReleaseFields(value: object): ReleaseSettingsFields {
  const text = (key: string) => {
    const field = Reflect.get(value, key)
    if (field === undefined) return undefined
    if (typeof field !== "string" || field.length > 512) throw new Error(`Invalid ${key}.`)
    return field
  }
  const packageManager = Reflect.get(value, "packageManager")
  if (packageManager !== undefined && !PACKAGE_MANAGERS.some((item) => item === packageManager)) {
    throw new Error("Invalid packageManager: use bun, pnpm, yarn, npm or static.")
  }
  const required = Reflect.get(value, "requiredChecks")
  if (
    required !== undefined &&
    (!required ||
      typeof required !== "object" ||
      Object.entries(required).some(([key, item]) => !(key in CHECK_LABELS) || typeof item !== "boolean"))
  ) {
    throw new Error("Invalid requiredChecks: name test, secrets, health or browser with true or false.")
  }
  return {
    framework: text("framework"),
    packageManager: packageManager as CloudBuildSettings["packageManager"] | undefined,
    installCommand: text("installCommand"),
    testCommand: text("testCommand"),
    buildCommand: text("buildCommand"),
    outputDirectory: text("outputDirectory"),
    nodeVersion: text("nodeVersion"),
    healthPath: text("healthPath"),
    requiredChecks: required as Partial<CloudRequiredChecks> | undefined,
  }
}

// What set_release_settings would change, for the permission prompt. It is
// Vector's own configuration, but it decides which checks may block a
// production release, so it asks like a hosting setting.
export async function describeReleaseSettings(input: ReleaseInput) {
  const current = await currentSettings(input)
  const next = mergeSettings(current, input)
  // Refuse a health path off the release's address before anyone is asked to approve it.
  normalizeHealthPath(next.healthPath)
  const changes = settingChanges(current, next)
  const project = getCloudProviderProjectLink(input.projectPath, input.taskId, "vercel")?.projectName
  return {
    ok: true as const,
    noop: changes.length === 0,
    scope: {
      provider: "Vector Cloud",
      project: project ?? basename(input.projectPath),
      environment: "release checks",
      summary: changes.length
        ? `Change the release settings Vector uses before it publishes: ${changes.join("; ")}.`
        : "These release settings are already saved; nothing changes.",
    },
    ...(changes.length ? {} : { text: "Those release settings are already saved; nothing changed." }),
  }
}

export async function runReleaseCommand(input: ReleaseInput) {
  if (input.command === "set_release_settings") {
    const current = await currentSettings(input)
    const next = mergeSettings(current, input)
    const changes = settingChanges(current, next)
    const saved = setBuildSettings(input.projectPath, input.taskId, next)
    return {
      ok: true,
      build: saved,
      text: [
        changes.length ? `Saved Vector's release settings: ${changes.join("; ")}.` : "Nothing changed.",
        `Required before production: ${requiredList(saved.requiredChecks)}.`,
        "They apply from the next publish.",
      ].join("\n"),
    }
  }
  if (input.command === "check_health") {
    if (!input.deploymentId) {
      const checked = await checkAllDeploymentHealth(input.projectPath, input.taskId)
      return {
        ok: true,
        text: checked.length
          ? ["Health of every release Vector published:", ...checked.map(healthLine)].join("\n")
          : "Vector has published no releases of this repository yet, so there is nothing to probe.",
      }
    }
    const release = findRelease(input)
    if (!release.ok) return release
    const checked = await checkDeploymentHealth({
      projectPath: input.projectPath,
      taskId: input.taskId,
      id: release.id,
    })
    return { ok: true, url: checked.url, text: healthLine(checked) }
  }
  if (!input.deploymentId) return { ok: false, error: "Name the release with deploymentId (see list_deployments)." }
  const release = findRelease(input)
  if (!release.ok) return release
  const checked = await rerunDeploymentChecks({ projectPath: input.projectPath, taskId: input.taskId, id: release.id })
  const failed = checked.checks.filter((check) => check.required && check.status === "failed")
  return {
    ok: true,
    url: checked.url,
    checks: checked.checks,
    text: [
      `Re-ran Vector's release checks on ${checked.url}${checked.providerDeploymentId ? ` (${checked.providerDeploymentId})` : ""}:`,
      ...checked.checks.map(
        (check) =>
          `${check.status} · ${check.label}${check.required ? " (required)" : ""}${check.details ? `: ${check.details}` : ""}`,
      ),
      failed.length
        ? "Required checks failed, so Vector will not promote this release to production."
        : "No required check failed.",
    ].join("\n"),
  }
}

async function currentSettings(input: ReleaseInput) {
  return (
    getBuildSettings(input.projectPath, input.taskId) ??
    (await detectBuildSettings(input.projectPath, input.taskId, input.directory))
  )
}

function mergeSettings(current: CloudBuildSettings, input: ReleaseSettingsFields) {
  return {
    framework: input.framework ?? current.framework,
    packageManager: input.packageManager ?? current.packageManager,
    installCommand: input.installCommand ?? current.installCommand,
    testCommand: input.testCommand ?? current.testCommand,
    buildCommand: input.buildCommand ?? current.buildCommand,
    outputDirectory: input.outputDirectory ?? current.outputDirectory,
    nodeVersion: input.nodeVersion ?? current.nodeVersion,
    healthPath: input.healthPath ?? current.healthPath,
    requiredChecks: { ...current.requiredChecks, ...input.requiredChecks },
  }
}

function settingChanges(current: CloudBuildSettings, next: ReturnType<typeof mergeSettings>) {
  return [
    ...COMMAND_FIELDS.flatMap(([key, label]) =>
      next[key] === current[key] ? [] : [next[key] ? `${label} ${next[key]}` : `no ${label}`],
    ),
    ...(Object.keys(CHECK_LABELS) as (keyof CloudRequiredChecks)[]).flatMap((key) =>
      next.requiredChecks[key] === current.requiredChecks[key]
        ? []
        : [
            next.requiredChecks[key]
              ? `${CHECK_LABELS[key]} becomes required before production`
              : `${CHECK_LABELS[key]} no longer blocks a production release`,
          ],
    ),
  ]
}

function requiredList(checks: CloudRequiredChecks) {
  const names = (Object.keys(CHECK_LABELS) as (keyof CloudRequiredChecks)[])
    .filter((key) => checks[key])
    .map((key) => CHECK_LABELS[key])
  return names.length ? names.join(", ") : "nothing"
}

// The agent names a release by Vercel's id or URL, from list_deployments; only
// releases Vector published carry Vector's checks and health records.
function findRelease(input: ReleaseInput): { ok: true; id: string } | { ok: false; error: string } {
  const wanted =
    input.deploymentId
      ?.trim()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "") ?? ""
  const release = listDeployments(input.projectPath, input.taskId).find(
    (item) =>
      item.id === wanted ||
      item.providerDeploymentId === wanted ||
      item.url.replace(/^https?:\/\//, "").replace(/\/$/, "") === wanted,
  )
  if (release) return { ok: true, id: release.id }
  return {
    ok: false,
    error: `Vector did not publish ${input.deploymentId}, so it has no release checks or health record. Inspect it with inspect_deployment and logs instead.`,
  }
}

function healthLine(release: CloudDeployment) {
  const where = `${release.url}${release.providerDeploymentId ? ` (${release.providerDeploymentId})` : ""}`
  if (release.probe === "protected") {
    return `${where} · protected: Vercel Deployment Protection kept the probe out; enable_protection_bypass lets Vector check it.`
  }
  return [
    where,
    release.status,
    release.statusCode ? `HTTP ${release.statusCode}` : undefined,
    release.latencyMs !== undefined ? `${release.latencyMs} ms` : undefined,
    release.healthError,
  ]
    .filter(Boolean)
    .join(" · ")
}
