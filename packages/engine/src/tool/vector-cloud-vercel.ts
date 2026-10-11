import { Schema } from "effect"

// The vector_cloud tool's Vercel actions: what the model may call, the
// parameters they take, and which permission each one asks for. The desktop
// bridge (packages/desktop/src/main/cloud-vercel-bridge.ts) runs them and
// returns `text` that already names only resources, never secret values.

export const VERCEL_READ_ACTIONS = [
  "vercel_scopes",
  "vercel_projects",
  "vercel_project",
  "inspect_deployment",
  "list_env",
  "env_diff",
  "env_plan",
  "list_domains",
] as const

// Each asks first, under the permission named in vercelPermission.
export const VERCEL_WRITE_ACTIONS = [
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

export const VERCEL_ACTIONS = [...VERCEL_READ_ACTIONS, ...VERCEL_WRITE_ACTIONS] as const

export type VercelAction = (typeof VERCEL_ACTIONS)[number]

const Target = Schema.Literals(["production", "preview", "development"])

export const VercelParameters = {
  source: Schema.optional(Schema.Literals(["build", "runtime"])).annotate({
    description:
      "For logs: build (what the build printed, the default) or runtime (what the running app logged: requests, errors, console output).",
  }),
  teamId: Schema.optional(Schema.String).annotate({
    description:
      "For vercel_projects, create_project and link_project: the Vercel team (from vercel_scopes). Omit for the connection's default scope.",
  }),
  projectId: Schema.optional(Schema.String).annotate({
    description: "For link_project: the Vercel projectId from vercel_projects.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "For create_project: the new Vercel project's name (lowercase letters, digits, '.', '_' or '-').",
  }),
  framework: Schema.optional(Schema.String).annotate({
    description:
      "For create_project and update_project_settings: Vercel's framework identifier, for example nextjs, vite, astro, sveltekit. An empty string returns it to automatic detection.",
  }),
  rootDirectory: Schema.optional(Schema.String).annotate({
    description: "For create_project and update_project_settings: the app's directory inside the repository.",
  }),
  buildCommand: Schema.optional(Schema.String).annotate({
    description: "For update_project_settings. An empty string returns it to automatic detection.",
  }),
  outputDirectory: Schema.optional(Schema.String).annotate({
    description: "For update_project_settings. An empty string returns it to automatic detection.",
  }),
  installCommand: Schema.optional(Schema.String).annotate({
    description: "For update_project_settings. An empty string returns it to automatic detection.",
  }),
  nodeVersion: Schema.optional(Schema.String).annotate({
    description:
      "For update_project_settings: 24.x or 22.x. Vercel no longer builds new deployments with 20.x or 18.x.",
  }),
  key: Schema.optional(Schema.String).annotate({ description: "For set_env and remove_env: the variable name." }),
  value: Schema.optional(Schema.String).annotate({
    description:
      "For set_env: a non-secret value. Omit it to copy the value stored for this key in the project's Vector environment; that is how secrets reach Vercel. Never ask for a secret in chat: the user adds it in Vector Cloud > Environment variables. Tool output never repeats a value.",
  }),
  targets: Schema.optional(Schema.Array(Target)).annotate({
    description:
      "For set_env, remove_env, env_plan and sync_environment: the Vercel environments. env_plan and sync_environment default to preview and development; include production only when the user asks.",
  }),
  gitBranch: Schema.optional(Schema.String).annotate({
    description: "For set_env and remove_env: a branch-specific preview value (targets must be [preview]).",
  }),
  envType: Schema.optional(Schema.Literals(["encrypted", "sensitive"])).annotate({
    description:
      "For set_env: sensitive values can never be read back, even by the user (not allowed for development).",
  }),
  domain: Schema.optional(Schema.String).annotate({
    description: "For add_domain, verify_domain and remove_domain: the domain, for example app.example.com.",
  }),
}

export function isVercelAction(action: string): action is VercelAction {
  return VERCEL_ACTIONS.some((item) => item === action)
}

// Moving production, rebuilding or canceling releases is publishing; project,
// protection and domain changes are hosting settings; variables are the host
// environment.
export function vercelPermission(action: string) {
  if (["promote", "rollback", "redeploy", "cancel_deployment"].includes(action)) return "vector_cloud_publish"
  if (["set_env", "remove_env", "pull_env"].includes(action)) return "vector_cloud_environment"
  if (VERCEL_WRITE_ACTIONS.some((item) => item === action)) return "vector_cloud_hosting"
  return undefined
}

export const VERCEL_GUIDANCE =
  "Vercel: list_deployments shows Vercel's own history including git pushes; inspect_deployment and logs (source build or runtime) explain a failure. promote moves production to a staged production build, and rollback returns it to an earlier one. redeploy of a production deployment builds it without moving production; promote it afterwards only if the user wants it live. Project setup: vercel_scopes, vercel_projects, link_project or create_project, vercel_project and update_project_settings. Variables: list_env shows names only; set_env and remove_env change one variable per environment, and set_env without a value copies the one the user stored in Vector; env_diff compares local values by hash; env_plan shows what sync_environment would write and the user approves that plan; pull_env writes development values into .env, which you can read and which publishing uploads with the source. Domains: list_domains, add_domain, verify_domain and remove_domain report the exact DNS records to set. If checks report Deployment Protection, offer enable_protection_bypass."
