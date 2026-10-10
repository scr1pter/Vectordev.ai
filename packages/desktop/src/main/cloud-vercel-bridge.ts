import { getCloudProviderProjectLink } from "./cloud-connections"
import { listDeployments, listEnv } from "./cloud-console"
import type { CloudScope } from "./cloud-scope"
import { vercelErrorReport, vercelLinkContext, VercelError, type VercelFetch } from "./cloud-vercel-api"
import {
  cancelVercelDeployment,
  inspectInProject,
  listVercelDeployments,
  previousProduction,
  promoteVercelDeployment,
  redeployVercelDeployment,
  requireVercelChecksPassed,
  rollbackVercelDeployment,
  type VercelDeployment,
} from "./cloud-vercel-deployments"
import {
  addVercelDomain,
  listVercelDomains,
  removeVercelDomain,
  verifyVercelDomain,
  type CertificateCheck,
  type VercelDomain,
} from "./cloud-vercel-domains"
import {
  applyVercelEnvPull,
  applyVercelEnvSync,
  diffVercelEnv,
  listVercelEnv,
  planVercelEnvPull,
  planVercelEnvSync,
  removeVercelEnv,
  setVercelEnv,
  VERCEL_ENV_TARGETS,
  type VercelEnvPlan,
  type VercelEnvTarget,
} from "./cloud-vercel-env"
import {
  createVercelProject,
  enableVercelProtectionBypass,
  linkVercelProject,
  listVercelProjects,
  listVercelScopes,
  unlinkVercelProject,
  updateVercelProjectSettings,
  vercelProjectStatus,
  VERCEL_NODE_VERSIONS,
} from "./cloud-vercel-projects"

// The vector_cloud tool's Vercel actions. Every report carries `text`, worded
// for the model: names, targets, states and URLs, never a secret value.

export const VERCEL_COMMANDS = [
  "vercel_scopes",
  "vercel_projects",
  "vercel_project",
  "inspect_deployment",
  "list_env",
  "env_diff",
  "env_plan",
  "list_domains",
  "create_project",
  "link_project",
  "unlink_project",
  "update_project_settings",
  "enable_protection_bypass",
  "promote",
  "rollback",
  "redeploy",
  "cancel_deployment",
  "set_env",
  "remove_env",
  "pull_env",
  "add_domain",
  "verify_domain",
  "remove_domain",
] as const

// The Vercel actions that change something; each is described for the
// permission prompt before it runs.
export const VERCEL_DESCRIBABLE = [
  "create_project",
  "link_project",
  "unlink_project",
  "update_project_settings",
  "enable_protection_bypass",
  "promote",
  "rollback",
  "redeploy",
  "cancel_deployment",
  "set_env",
  "remove_env",
  "pull_env",
  "add_domain",
  "verify_domain",
  "remove_domain",
] as const

export type VercelCommand = (typeof VERCEL_COMMANDS)[number]

export type VercelCommandFields = {
  teamId?: string
  projectId?: string
  name?: string
  framework?: string
  rootDirectory?: string
  buildCommand?: string
  outputDirectory?: string
  installCommand?: string
  nodeVersion?: string
  key?: string
  value?: string
  targets?: VercelEnvTarget[]
  gitBranch?: string
  envType?: "encrypted" | "sensitive"
  planId?: string
  domain?: string
}

type VercelBridgeInput = VercelCommandFields & {
  command: string
  action?: string
  projectPath: string
  deploymentId?: string
  limit?: number
}

export type VercelBridgeOptions = { request?: VercelFetch; certificate?: CertificateCheck }

const SETTING_FIELDS = [
  "framework",
  "rootDirectory",
  "buildCommand",
  "outputDirectory",
  "installCommand",
  "nodeVersion",
] as const

export function parseVercelFields(value: object): VercelCommandFields {
  const text = (key: keyof VercelCommandFields, max = 512) => {
    const field = Reflect.get(value, key)
    if (field === undefined) return undefined
    if (typeof field !== "string" || field.length > max) throw new Error(`Invalid ${key}.`)
    return field
  }
  const targets = Reflect.get(value, "targets")
  if (
    targets !== undefined &&
    (!Array.isArray(targets) || !targets.every((target) => VERCEL_ENV_TARGETS.some((known) => known === target)))
  ) {
    throw new Error("Invalid environment targets: use production, preview and development.")
  }
  const envType = Reflect.get(value, "envType")
  if (envType !== undefined && envType !== "encrypted" && envType !== "sensitive") throw new Error("Invalid envType.")
  return {
    teamId: text("teamId"),
    projectId: text("projectId"),
    name: text("name"),
    framework: text("framework"),
    rootDirectory: text("rootDirectory"),
    buildCommand: text("buildCommand"),
    outputDirectory: text("outputDirectory"),
    installCommand: text("installCommand"),
    nodeVersion: text("nodeVersion"),
    key: text("key"),
    value: text("value", 64 * 1024),
    targets: targets as VercelEnvTarget[] | undefined,
    gitBranch: text("gitBranch"),
    envType,
    planId: text("planId"),
    domain: text("domain"),
  }
}

type Scope = { provider: "Vercel"; project: string; environment: string; summary: string }

function described(project: string, environment: string, summary: string, carry?: Record<string, unknown>) {
  const scope: Scope = { provider: "Vercel", project, environment, summary }
  return { ok: true as const, scope, carry }
}

// What a changing Vercel action would touch, for the permission prompt. A
// report that is not ok means the action cannot run, so nothing is asked.
export async function describeVercelAction(
  input: VercelBridgeInput,
  scope: CloudScope,
  options: VercelBridgeOptions = {},
) {
  return describe(input, scope, options).catch(vercelErrorReport)
}

async function describe(input: VercelBridgeInput, scope: CloudScope, options: VercelBridgeOptions) {
  const action = input.action
  if (action === "create_project") {
    const name = input.name?.trim()
    if (!name) return { ok: false as const, error: "Name the new Vercel project with name." }
    return described(
      name,
      "new project",
      `Create the Vercel project ${name}${input.teamId ? ` in team ${input.teamId}` : ""}${input.framework ? ` (${input.framework})` : ""}${input.rootDirectory ? ` with root directory ${input.rootDirectory}` : ""}, and link it to this project.`,
    )
  }
  if (action === "link_project") {
    if (!input.projectId)
      return { ok: false as const, error: "Name the Vercel project to link with projectId (see vercel_projects)." }
    return described(
      input.projectId,
      "project link",
      `Link this project to the Vercel project ${input.projectId}. Publishing, domains and variables then act on it.`,
    )
  }
  const context = await vercelLinkContext(scope.projectPath)
  const project = context.link.projectName
  if (action === "unlink_project") {
    return described(
      project,
      "project link",
      `Unlink the Vercel project ${project} from this project. Nothing changes on Vercel.`,
    )
  }
  if (action === "update_project_settings") {
    const changes = SETTING_FIELDS.flatMap((key) =>
      input[key] === undefined ? [] : [`${key} = ${input[key] || "(automatic)"}`],
    )
    if (!changes.length)
      return { ok: false as const, error: `Name at least one setting: ${SETTING_FIELDS.join(", ")}.` }
    return described(
      project,
      "production and preview builds",
      `Change the Vercel project ${project}'s build settings: ${changes.join("; ")}. The next deployment builds with them.`,
    )
  }
  if (action === "enable_protection_bypass") {
    return described(
      project,
      "all deployments",
      `Create a Protection Bypass for Automation secret on the Vercel project ${project}, so Vector's release checks can open protected deployments. Vector keeps the secret in its vault.`,
    )
  }
  if (action === "promote" || action === "rollback") {
    if (action === "promote" && !input.deploymentId)
      return { ok: false as const, error: "Name the deployment to promote with deploymentId (see list_deployments)." }
    // A rollback without an id is resolved now, so the prompt names the
    // deployment that will serve production and the approved run uses it.
    const deployment = input.deploymentId
      ? await inspectInProject(context, input.deploymentId, options.request)
      : await previousProduction(scope.projectPath, context, options)
    // Nothing to approve when the move would be refused for failed checks.
    requireVercelChecksPassed(scope.projectPath, deployment)
    return described(
      project,
      "production",
      action === "promote"
        ? `Point production traffic of the Vercel project ${project} at ${deployment.url} (${deployment.id}).`
        : `Roll production of the Vercel project ${project} back to ${deployment.url} (${deployment.id}). Vercel stops assigning new production deployments to the domains until one is promoted again.`,
      { deploymentId: deployment.id },
    )
  }
  if (action === "redeploy" || action === "cancel_deployment") {
    if (!input.deploymentId)
      return { ok: false as const, error: "Name the deployment with deploymentId (see list_deployments)." }
    const deployment = await inspectInProject(context, input.deploymentId, options.request)
    return described(
      project,
      deployment.target,
      action === "redeploy"
        ? `Rebuild ${deployment.url} (${deployment.id}) on the Vercel project ${project} as a new ${deployment.target} deployment.${deployment.target === "production" ? " It is built without taking production's domains, so production does not move until it is promoted." : ""}`
        : `Cancel the ${deployment.state.toLowerCase()} ${deployment.target} deployment ${deployment.id} on the Vercel project ${project}.`,
    )
  }
  if (action === "set_env" || action === "remove_env") {
    if (!input.key) return { ok: false as const, error: "Name the variable with key." }
    const targets = input.targets?.length ? input.targets : action === "set_env" ? undefined : [...VERCEL_ENV_TARGETS]
    if (!targets)
      return { ok: false as const, error: "Choose targets for the variable: production, preview and/or development." }
    const stored = action === "set_env" && input.value === undefined
    if (stored && storedEnvValue(scope.projectPath, input.key) === undefined)
      return { ok: false as const, error: missingStoredValue(input.key) }
    return described(
      project,
      targets.join(", "),
      action === "set_env"
        ? `Set ${input.key}${stored ? " to the value stored for it in this project's Vector environment" : ""} on the Vercel project ${project} for ${targets.join(", ")}${input.gitBranch ? ` (branch ${input.gitBranch})` : ""}. Deployments pick it up when they are next built.`
        : `Remove ${input.key} from the Vercel project ${project} for ${targets.join(", ")}${input.gitBranch ? ` (branch ${input.gitBranch})` : ""}.`,
    )
  }
  if (action === "pull_env") {
    const plan = await planVercelEnvPull(scope.projectPath, { request: options.request })
    const written = plan.variables.filter((item) => item.action !== "unchanged")
    if (!written.length) {
      return {
        ok: true as const,
        noop: true,
        text: `Nothing to pull: this project's .env already has every development value ${project} reveals.`,
      }
    }
    return described(
      project,
      "development → local .env",
      `Write ${written.length} development value(s) from the Vercel project ${project} into Vector's environment for this project and its .env: ${written.map((item) => `${item.key} (${item.action})`).join(", ")}. The agent can read .env, and publishing uploads it to Vercel with the source (a site without a build step must leave it out with .vercelignore).`,
      { planId: plan.id },
    )
  }
  if (action === "sync_environment") {
    const targets = input.targets?.length ? input.targets : (["preview", "development"] as VercelEnvTarget[])
    const plan = await planVercelEnvSync(scope.projectPath, targets, { request: options.request })
    if (!plan.changes.length) return { ok: true as const, noop: true, text: planText(plan) }
    return described(
      project,
      targets.join(", "),
      `Sync environment variables to the Vercel project ${project}: ${changeList(plan)}.`,
      {
        planId: plan.id,
        targets,
      },
    )
  }
  if (action === "add_domain" || action === "verify_domain" || action === "remove_domain") {
    if (!input.domain) return { ok: false as const, error: "Name the domain with domain." }
    return described(
      project,
      "production",
      action === "add_domain"
        ? `Attach ${input.domain} to the Vercel project ${project}. Once its DNS points at Vercel, it serves production.`
        : action === "verify_domain"
          ? `Ask Vercel to verify ${input.domain} on the project ${project} and read its DNS and certificate state.`
          : `Detach ${input.domain} from the Vercel project ${project}. The domain stops serving this app.`,
    )
  }
  return { ok: false as const, error: "That Vercel action cannot be described." }
}

export async function runVercelCommand(input: VercelBridgeInput, scope: CloudScope, options: VercelBridgeOptions = {}) {
  return run(input, scope, options).catch(vercelErrorReport)
}

async function run(input: VercelBridgeInput, scope: CloudScope, options: VercelBridgeOptions) {
  const request = options.request
  const projectPath = scope.projectPath
  const command = input.command
  if (command === "vercel_scopes") {
    const listed = await listVercelScopes(request)
    return text(
      [
        "Vercel scopes the connected token can use (pass teamId to vercel_projects or create_project; personal needs no teamId):",
        ...listed.scopes.map(
          (item) =>
            `- ${item.name} (${item.kind === "team" ? `teamId ${item.teamId}` : "personal account"}, slug ${item.slug})${item.teamId === listed.selected || (!item.teamId && !listed.selected) ? " · default" : ""}`,
        ),
      ].join("\n"),
    )
  }
  if (command === "vercel_projects") {
    const projects = await listVercelProjects(input.teamId, request)
    const linked = getCloudProviderProjectLink(projectPath, undefined, "vercel")
    return text(
      projects.length
        ? [
            `${projects.length} Vercel project(s)${input.teamId ? ` in team ${input.teamId}` : ""}:`,
            ...projects.map(
              (item) =>
                `- ${item.name} (projectId ${item.id}${item.framework ? `, ${item.framework}` : ""}${item.productionUrl ? `, ${item.productionUrl}` : ""})${item.id === linked?.projectId ? " · linked to this project" : ""}`,
            ),
          ].join("\n")
        : "No Vercel projects in this scope. Create one with create_project.",
    )
  }
  if (command === "vercel_project") {
    const status = await vercelProjectStatus(projectPath, scope.directory, request, { autoLink: false })
    if (!status.connected) {
      return vercelErrorReport(
        new VercelError("not_connected", "Vercel is not connected. Connect it in Cloud Services > Integrations."),
      )
    }
    if (!status.link) {
      return {
        ok: true,
        text: [
          `Vercel is connected${status.account ? ` as ${status.account}` : ""}, but no project is linked.`,
          status.candidate
            ? `This repository's .vercel/project.json names projectId ${status.candidate.projectId}${status.candidate.teamId ? ` (teamId ${status.candidate.teamId})` : ""}; link it with link_project, which the user approves.`
            : "Use vercel_projects then link_project, or create_project.",
        ].join(" "),
      }
    }
    const project = status.project
    return text(
      [
        `Linked Vercel project: ${status.link.projectName} (projectId ${status.link.projectId}${status.link.teamId ? `, teamId ${status.link.teamId}` : ", personal account"})${status.link.linkedFrom ? `, linked from ${status.link.linkedFrom}` : ""}.`,
        status.error ? `Vercel could not be read: ${status.error}` : undefined,
        project?.productionUrl
          ? `Production: ${project.productionUrl}`
          : project
            ? "Production: nothing deployed yet."
            : undefined,
        project?.gitRepository ? `Git repository: ${project.gitRepository} (pushes deploy automatically).` : undefined,
        project
          ? `Settings: framework ${project.settings.framework ?? "automatic"}, root directory ${project.settings.rootDirectory ?? "(repository root)"}, build ${project.settings.buildCommand ?? "automatic"}, output ${project.settings.outputDirectory ?? "automatic"}, install ${project.settings.installCommand ?? "automatic"}, Node.js ${project.settings.nodeVersion ?? "default"}.`
          : undefined,
        project
          ? `Deployment Protection: ${project.protection.vercelAuthentication ? `Vercel Authentication (${project.protection.vercelAuthentication})` : "Vercel Authentication off"}${project.protection.passwordProtection ? ", password" : ""}; ${project.protection.bypassReady ? "Vector can check protected deployments." : "Vector cannot open protected deployments until enable_protection_bypass runs."}`
          : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }
  if (command === "list_deployments") return deploymentsReport(projectPath, input.limit, request)
  if (command === "inspect_deployment") {
    if (!input.deploymentId)
      return { ok: false, error: "Name the deployment with deploymentId (see list_deployments)." }
    const context = await vercelLinkContext(projectPath)
    const deployment = await inspectInProject(context, input.deploymentId, request)
    return text(
      [
        deploymentLine(deployment, checksFor(projectPath, deployment)),
        deployment.aliases.length
          ? `Aliases: ${deployment.aliases.map((alias) => `https://${alias}`).join(", ")}`
          : undefined,
        deployment.errorMessage ? `Error: ${deployment.errorMessage}` : undefined,
        deployment.inspectorUrl ? `Vercel inspector: ${deployment.inspectorUrl}` : undefined,
        deployment.state === "ERROR" ? "Read why with logs (source build) for this deploymentId." : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      { url: deployment.url },
    )
  }
  if (command === "list_env") {
    const listed = await listVercelEnv(projectPath, { request })
    return text(
      listed.variables.length
        ? [
            `Environment variables on ${listed.project} (names only; values are never shown):`,
            ...listed.variables.map(
              (item) =>
                `- ${item.key} · ${item.targets.join(", ") || "custom environment"}${item.gitBranch ? ` · branch ${item.gitBranch}` : ""} · ${item.type}${item.syncedByVector ? " · synced by Vector" : ""}`,
            ),
          ].join("\n")
        : `${listed.project} has no environment variables.`,
    )
  }
  if (command === "env_diff") {
    const diff = await diffVercelEnv(projectPath, { request })
    const label = {
      same: "same",
      different: "DIFFERENT",
      missing_remote: "missing on Vercel",
      remote_only: "only on Vercel",
      unknown: "set (value not readable)",
      absent: "-",
    }
    return text(
      [
        `Local variables against ${diff.project}, compared by hash inside Vector (production / preview / development):`,
        ...diff.rows.map(
          (row) =>
            `- ${row.key}${row.local ? "" : " (not local)"}: ${VERCEL_ENV_TARGETS.map((target) => label[row.targets[target]]).join(" / ")}${row.branchOverrides.length ? ` · branch values: ${row.branchOverrides.join(", ")}` : ""}`,
        ),
      ].join("\n") || `${diff.project} and this project have no variables.`,
    )
  }
  if (command === "env_plan") {
    return text(
      planText(
        await planVercelEnvSync(projectPath, input.targets?.length ? input.targets : ["preview", "development"], {
          request,
        }),
      ),
    )
  }
  if (command === "sync_environment") {
    if (!input.planId) return { ok: false, error: "Sync runs an approved plan; call it through the permission prompt." }
    const targets = input.targets?.length ? input.targets : (["preview", "development"] as VercelEnvTarget[])
    const applied = await applyVercelEnvSync(projectPath, targets, input.planId, { request })
    return text(`Applied the plan to ${applied.project}: ${changeList(applied) || "no changes"}.`, {
      nextStep: applied.nextStep,
    })
  }
  if (command === "pull_env") {
    if (!input.planId)
      return { ok: false, error: "Pulling writes approved values; call it through the permission prompt." }
    const pulled = await applyVercelEnvPull(projectPath, input.planId, scope.directory, { request })
    return text(
      `Wrote ${pulled.keys.length} development value(s) from ${pulled.project} into .env: ${pulled.keys.join(", ") || "none"}.${pulled.skipped.length ? ` Skipped: ${pulled.skipped.map((item) => `${item.key} (${item.reason})`).join(", ")}.` : ""}`,
    )
  }
  if (command === "set_env") {
    if (!input.key || !input.targets?.length) return { ok: false, error: "set_env needs key and targets." }
    const value = input.value ?? storedEnvValue(projectPath, input.key)
    if (value === undefined) return { ok: false, error: missingStoredValue(input.key) }
    const set = await setVercelEnv(
      projectPath,
      { key: input.key, value, targets: input.targets, gitBranch: input.gitBranch, type: input.envType },
      { request },
    )
    return text(
      `${set.action === "created" ? "Created" : "Updated"} ${set.key} on ${set.project} for ${set.targets.join(", ")}${set.gitBranch ? ` (branch ${set.gitBranch})` : ""}.`,
      {
        nextStep: "Redeploy for the new value to take effect.",
      },
    )
  }
  if (command === "remove_env") {
    if (!input.key) return { ok: false, error: "remove_env needs key." }
    const removed = await removeVercelEnv(
      projectPath,
      { key: input.key, targets: input.targets, gitBranch: input.gitBranch },
      { request },
    )
    return text(`Removed ${removed.key} from ${removed.project} for ${removed.targets.join(", ")}.`, {
      nextStep: "Redeploy for the change to take effect.",
    })
  }
  if (command === "list_domains") {
    const listed = await listVercelDomains(projectPath, { request, certificate: options.certificate })
    return text(
      listed.domains.length
        ? [`Domains on ${listed.project}:`, ...listed.domains.map(domainText)].join("\n")
        : `${listed.project} has no custom domains. Add one with add_domain.`,
    )
  }
  if (command === "add_domain" || command === "verify_domain" || command === "remove_domain") {
    if (!input.domain) return { ok: false, error: "Name the domain with domain." }
    if (command === "remove_domain") {
      const removed = await removeVercelDomain(projectPath, input.domain, { request })
      return text(`Removed ${removed.removed} from ${removed.project}.`)
    }
    const result =
      command === "add_domain"
        ? await addVercelDomain(projectPath, input.domain, { request, certificate: options.certificate })
        : await verifyVercelDomain(projectPath, input.domain, { request, certificate: options.certificate })
    return text(`${command === "add_domain" ? "Added" : "Checked"} on ${result.project}:\n${domainText(result.domain)}`)
  }
  if (command === "create_project") {
    if (!input.name) return { ok: false, error: "create_project needs name." }
    const link = await createVercelProject(
      projectPath,
      { name: input.name, framework: input.framework, rootDirectory: input.rootDirectory, teamId: input.teamId },
      request,
    )
    return text(
      `Created the Vercel project ${link.projectName} (projectId ${link.projectId}) and linked it to this project.`,
      {
        nextStep: "Publish to deploy it. The first deployment of a new Vercel project is always production.",
      },
    )
  }
  if (command === "link_project") {
    if (!input.projectId) return { ok: false, error: "link_project needs projectId." }
    const link = await linkVercelProject(projectPath, input.projectId, input.teamId, request)
    return text(`Linked the Vercel project ${link.projectName} (projectId ${link.projectId}).`)
  }
  if (command === "unlink_project") {
    await unlinkVercelProject(projectPath)
    return text("Unlinked the Vercel project. Nothing changed on Vercel.")
  }
  if (command === "update_project_settings") {
    const patch = Object.fromEntries(
      SETTING_FIELDS.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])),
    )
    const project = await updateVercelProjectSettings(projectPath, patch, request)
    return text(
      `Updated ${project.name}: framework ${project.settings.framework ?? "automatic"}, root directory ${project.settings.rootDirectory ?? "(repository root)"}, build ${project.settings.buildCommand ?? "automatic"}, output ${project.settings.outputDirectory ?? "automatic"}, install ${project.settings.installCommand ?? "automatic"}, Node.js ${project.settings.nodeVersion ?? "default"}.`,
      {
        nextStep: `The next deployment builds with these settings. Node.js versions Vercel accepts: ${VERCEL_NODE_VERSIONS.join(", ")}.`,
      },
    )
  }
  if (command === "enable_protection_bypass") {
    const enabled = await enableVercelProtectionBypass(projectPath, request)
    return text(
      `Protection Bypass for Automation is on for ${enabled.project}. Vector's release checks can now open protected deployments.`,
    )
  }
  if (command === "promote") {
    if (!input.deploymentId) return { ok: false, error: "promote needs deploymentId (see list_deployments)." }
    const promoted = await promoteVercelDeployment(projectPath, input.deploymentId, { request })
    return text(`Production now serves ${promoted.deployment.url} (${promoted.deployment.id}).`, {
      url: promoted.productionUrl ?? promoted.deployment.url,
      nextStep: promoted.productionUrl ? `Production URL: ${promoted.productionUrl}` : undefined,
    })
  }
  if (command === "rollback") {
    const rolled = await rollbackVercelDeployment(projectPath, input.deploymentId, { request })
    return text(
      `Rolled production back to ${rolled.deployment.url} (${rolled.deployment.id})${rolled.replaced ? `, replacing ${rolled.replaced}` : ""}.`,
      {
        url: rolled.productionUrl ?? rolled.deployment.url,
        nextStep:
          "Vercel keeps production on this deployment until another one is promoted; new production builds are not assigned automatically meanwhile.",
      },
    )
  }
  if (command === "redeploy") {
    if (!input.deploymentId) return { ok: false, error: "redeploy needs deploymentId." }
    const redeployed = await redeployVercelDeployment(projectPath, input.deploymentId, { request })
    return text(
      `Started ${redeployed.deployment.id} (${redeployed.deployment.target}) rebuilding ${redeployed.from.id}: ${redeployed.deployment.url}`,
      {
        url: redeployed.deployment.url,
        nextStep:
          redeployed.deployment.target === "production"
            ? "Production did not move: the build does not take production's domains. Check it with inspect_deployment (logs with source build if it fails); when it is READY, promote it only if the user wants production on it."
            : "Check it with inspect_deployment; read logs with source build if it fails.",
      },
    )
  }
  if (command === "cancel_deployment") {
    if (!input.deploymentId) return { ok: false, error: "cancel_deployment needs deploymentId." }
    const canceled = await cancelVercelDeployment(projectPath, input.deploymentId, { request })
    return text(`Canceled ${canceled.id}.`)
  }
  return { ok: false, error: "Unsupported Vercel action." }
}

function text(value: string, extra: { url?: string; nextStep?: string } = {}) {
  return { ok: true as const, text: value, ...extra }
}

function changeList(plan: Pick<VercelEnvPlan, "changes">) {
  return plan.changes.map((change) => `${change.action} ${change.key} (${change.targets.join(", ")})`).join("; ")
}

function planText(plan: VercelEnvPlan) {
  return [
    `Sync plan for ${plan.project}, environments ${plan.targets.join(", ")} (plan ${plan.id}):`,
    plan.changes.length ? changeList(plan) : "Nothing to change.",
    plan.skipped.length
      ? `Left alone: ${plan.skipped.map((item) => `${item.key} (${item.targets.join(", ")}: ${item.reason})`).join("; ")}`
      : undefined,
    plan.unchanged ? `${plan.unchanged} value(s) already match.` : undefined,
    plan.changes.length
      ? "Run sync_environment with the same targets to apply it; the user approves it first."
      : undefined,
  ]
    .filter(Boolean)
    .join("\n")
}

function domainText(domain: VercelDomain) {
  const records = domain.records
    .map((record) => `${record.type} ${record.name} → ${record.value} (${record.purpose})`)
    .join("; ")
  const certificate = domain.certificate
    ? domain.certificate.status === "issued"
      ? `certificate valid until ${domain.certificate.expiresAt}`
      : `certificate pending: ${domain.certificate.detail}`
    : "certificate after DNS is configured"
  return `- ${domain.name}: ${domain.status.replace("_", " ")} · ${records} · ${certificate}. ${domain.detail}`
}

function checksFor(projectPath: string, deployment: VercelDeployment) {
  return listDeployments(projectPath).find(
    (item) => item.providerDeploymentId === deployment.id || item.url === new URL(deployment.url).toString(),
  )
}

function deploymentLine(deployment: VercelDeployment, recorded?: ReturnType<typeof checksFor>) {
  const failed = recorded?.checks.filter((check) => check.required && check.status === "failed").length ?? 0
  const checks = recorded?.checks.length
    ? ` · Vector checks: ${failed ? `${failed} failed` : `${recorded.checks.filter((check) => check.status === "passed").length} passed`}`
    : ""
  const git = deployment.branch
    ? ` · ${deployment.branch}${deployment.commitSha ? `@${deployment.commitSha.slice(0, 7)}` : ""}${deployment.commitMessage ? ` "${deployment.commitMessage.split("\n")[0].slice(0, 80)}"` : ""}`
    : ""
  return `- ${deployment.id} · ${deployment.state} · ${deployment.target}${deployment.current ? " (serving production)" : ""} · ${deployment.url}${git} · ${deployment.createdAt}${deployment.source ? ` · via ${deployment.source}` : ""}${checks}`
}

async function deploymentsReport(projectPath: string, limit: number | undefined, request?: VercelFetch) {
  const linked = getCloudProviderProjectLink(projectPath, undefined, "vercel")
  if (!linked) {
    const recorded = listDeployments(projectPath).slice(0, 20)
    return text(
      recorded.length
        ? [
            "No Vercel project is linked, so only releases Vector recorded are listed:",
            ...recorded.map(
              (item) =>
                `- ${item.id} · ${item.environment} · ${item.releaseStatus} · ${item.productionUrl ?? item.url} · ${item.createdAt}`,
            ),
          ].join("\n")
        : "No deployments yet, and no Vercel project is linked.",
    )
  }
  const deployments = await listVercelDeployments(projectPath, { limit: limit ?? 20 }, { request })
  return text(
    deployments.length
      ? [
          `Deployments of the Vercel project ${linked.projectName}, newest first (git pushes included):`,
          ...deployments.map((item) => deploymentLine(item, checksFor(projectPath, item))),
        ].join("\n")
      : `The Vercel project ${linked.projectName} has no deployments yet.`,
  )
}

// What `status` reports about Vercel without calling it: the link and how many
// local variables a sync would consider.
export function vercelStatusSummary(projectPath: string) {
  const link = getCloudProviderProjectLink(projectPath, undefined, "vercel")
  return link
    ? {
        project: link.projectName,
        projectId: link.projectId,
        teamId: link.teamId,
        linkedFrom: link.linkedFrom,
        localVariables: listEnv(projectPath).length,
      }
    : undefined
}

// set_env without a value copies the one the user stored in Cloud Services, so
// a secret reaches Vercel without passing through the model.
function storedEnvValue(projectPath: string, key: string) {
  return listEnv(projectPath).find((item) => item.key === key)?.value
}

function missingStoredValue(key: string) {
  return `${key} has no value in this project's Vector environment. Ask the user to add it in Cloud Services > Environment variables (never in chat), then call set_env again without a value.`
}
