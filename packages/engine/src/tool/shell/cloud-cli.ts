export * as CloudCli from "./cloud-cli"

import path from "node:path"

// Vercel and Supabase command-line calls that act on the user's cloud accounts.
// vector_cloud asks for the same work every time, under a permission that
// auto-accept, permission rules and earlier approvals never answer
// (PermissionPolicy). Typed into the shell instead, it would run on the CLI's
// own login without a prompt, so the shell asks under that same permission.
// This reads the command as written: a script that calls a CLI (`npm run
// deploy`, `sh -c "..."`) is not seen here, which is what the shell sandbox's
// denied CLI logins are for.

export type Permission =
  | "vector_cloud_publish"
  | "vector_cloud_environment"
  | "vector_cloud_hosting"
  | "vector_cloud_database"

export type Request = {
  permission: Permission
  provider: "Vercel" | "Supabase"
  environment: string
  /** The CLI subcommand, such as "deploy" or "db push". */
  action: string
  summary: string
}

/** What a shell command's tokens ask for, or undefined when it touches no cloud account. */
export function request(tokens: readonly string[]): Request | undefined {
  const invocation = unwrap(tokens.map(unquote))
  if (!invocation) return
  if (invocation.cli === "vercel") return vercel(invocation.args)
  return supabase(invocation.args)
}

// Programs that run the command after them, and package runners that run a
// package's binary: `npx --yes vercel@59 deploy`, `pnpm dlx supabase db push`.
const WRAPPERS = new Set(["env", "time", "nohup", "exec", "command", "sudo", "npx", "bunx", "pnpx"])
const RUNNER_VERBS: Record<string, Set<string>> = {
  npm: new Set(["exec", "x"]),
  pnpm: new Set(["dlx", "exec"]),
  yarn: new Set(["dlx", "exec"]),
  bun: new Set(["x", "run"]),
}
// Runner flags that take a value, so the value is not read as the program.
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "-u", "--user", "-g", "--group"])

function unwrap(tokens: string[]): { cli: "vercel" | "supabase"; args: string[] } | undefined {
  const [first, ...rest] = tokens
  if (!first) return
  const name = program(first)
  if (name === "vercel" || name === "vc") return { cli: "vercel", args: rest }
  if (name === "supabase") return { cli: "supabase", args: rest }
  if (WRAPPERS.has(name)) return unwrap(skipOptions(rest))
  const verbs = RUNNER_VERBS[name]
  if (!verbs) return
  // `pnpm vercel`, `yarn supabase` and `bun vercel` run a project binary too.
  const next = rest[0] ? program(rest[0]) : ""
  if (next === "vercel" || next === "vc" || next === "supabase") return unwrap(rest)
  if (!verbs.has(next)) return
  return unwrap(skipOptions(rest.slice(1)))
}

function skipOptions(tokens: string[]): string[] {
  const [first, ...rest] = tokens
  if (first === undefined) return []
  if (first === "--") return rest
  // `env NAME=value cmd`
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return skipOptions(rest)
  if (!first.startsWith("-")) return tokens
  if (RUNNER_VALUE_FLAGS.has(first)) return skipOptions(rest.slice(1))
  return skipOptions(rest)
}

// The program a token names: a path's file name, without a Windows extension
// or an npm version (`vercel@59.26.0`).
function program(token: string) {
  return path
    .basename(token.replaceAll("\\", "/"))
    .toLowerCase()
    .replace(/\.(cmd|exe|ps1|bat|js|mjs|cjs)$/, "")
    .replace(/@[^@/]*$/, "")
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  if ((first === '"' || first === "'") && text[text.length - 1] === first) return text.slice(1, -1)
  return text
}

// The words of a command line that are not flags or flag values.
function words(args: string[], valueFlags: Set<string>) {
  return args.flatMap((arg, index) => {
    if (arg.startsWith("-")) return []
    const previous = args[index - 1]
    if (previous && valueFlags.has(previous)) return []
    return [arg.toLowerCase()]
  })
}

const INFO_FLAGS = new Set(["-v", "--version", "-h", "--help"])
const READS = new Set(["ls", "list", "inspect", "get", "show"])

const VERCEL_VALUE_FLAGS = new Set([
  "--scope",
  "-S",
  "--team",
  "-T",
  "--token",
  "-t",
  "--cwd",
  "--local-config",
  "-A",
  "--global-config",
  "-Q",
  "--api",
  "--target",
  "--meta",
  "-m",
  "--env",
  "-e",
  "--build-env",
  "-b",
  "--environment",
])
// Run on this machine or only read: no account changes.
const VERCEL_LOCAL = new Set([
  "dev",
  "build",
  "help",
  "whoami",
  "list",
  "ls",
  "inspect",
  "logs",
  "open",
  "telemetry",
  "init",
  "bisect",
  "httpstat",
  "curl",
  "login",
  "logout",
  "switch",
  "completion",
])
const VERCEL_RELEASES = new Set([
  "promote",
  "rollback",
  "redeploy",
  "remove",
  "rm",
  "alias",
  "aliases",
  "rolling-release",
])
const VERCEL_ENVIRONMENT = new Set(["env", "pull"])

function vercel(args: string[]): Request | undefined {
  const [sub, second] = words(args, VERCEL_VALUE_FLAGS)
  if (!sub && args.length && args.every((arg) => INFO_FLAGS.has(arg))) return
  if (sub && VERCEL_LOCAL.has(sub)) return
  // `vercel`, `vercel --prod` and `vercel <dir>` deploy, as `vercel deploy` does.
  if (!sub || sub === "deploy" || !KNOWN_VERCEL.has(sub)) {
    const production = args.some(
      (arg, index) =>
        arg === "--prod" || arg === "--target=production" || (arg === "--target" && args[index + 1] === "production"),
    )
    return {
      permission: "vector_cloud_publish",
      provider: "Vercel",
      environment: production ? "production" : "preview",
      action: "deploy",
      summary: `deploy this folder to ${production ? "production" : "a preview"}`,
    }
  }
  // `vercel env ls` lists names only; nothing else under env or pull is a plain read.
  if (second && READS.has(second) && !VERCEL_ENVIRONMENT.has(sub)) return
  if (sub === "env" && (second === "ls" || second === "list")) return
  if (VERCEL_RELEASES.has(sub)) {
    return {
      permission: "vector_cloud_publish",
      provider: "Vercel",
      environment: "production",
      action: sub,
      summary: "change which deployment serves the project, or remove deployments",
    }
  }
  if (VERCEL_ENVIRONMENT.has(sub)) {
    return {
      permission: "vector_cloud_environment",
      provider: "Vercel",
      environment: "environment variables",
      action: [sub, second].filter(Boolean).join(" "),
      summary:
        sub === "pull" || second === "pull"
          ? "write the project's environment variables, secrets included, into local files"
          : "change the project's environment variables",
    }
  }
  return {
    permission: "vector_cloud_hosting",
    provider: "Vercel",
    environment: "account",
    action: [sub, second].filter(Boolean).join(" "),
    summary: "change the Vercel project, its domains or the account",
  }
}

// Subcommands the Vercel CLI has; any other first word is a folder to deploy.
const KNOWN_VERCEL = new Set([
  ...VERCEL_LOCAL,
  ...VERCEL_RELEASES,
  ...VERCEL_ENVIRONMENT,
  "deploy",
  "link",
  "unlink",
  "project",
  "projects",
  "domains",
  "domain",
  "dns",
  "certs",
  "cert",
  "teams",
  "team",
  "git",
  "integration",
  "integrations",
  "integration-resource",
  "install",
  "blob",
  "cache",
  "target",
  "targets",
  "microfrontends",
  "redirects",
  "routes",
  "webhooks",
  "edge-config",
  "flags",
  "mcp",
  "api",
  "guidance",
])

const SUPABASE_VALUE_FLAGS = new Set([
  "--workdir",
  "--project-ref",
  "--db-url",
  "-p",
  "--password",
  "--profile",
  "-o",
  "--output",
  "--schema",
  "-s",
  "--org-id",
  "--region",
  "--name",
  "--env-file",
])
// Local development and reads of the linked project that return no data or keys.
const SUPABASE_LOCAL = new Set([
  "start",
  "stop",
  "status",
  "init",
  "help",
  "completion",
  "gen",
  "test",
  "inspect",
  "services",
  "login",
  "logout",
])
// Second words that only work on this machine or only read.
const SUPABASE_LOCAL_SECOND: Record<string, Set<string>> = {
  functions: new Set(["new", "serve", "download", "list"]),
  migration: new Set(["new", "list", "fetch"]),
  db: new Set(["diff", "lint", "start", "pull"]),
  secrets: new Set(["list"]),
  projects: new Set(["list"]),
  orgs: new Set(["list"]),
  branches: new Set(["list"]),
  snippets: new Set(["list", "download"]),
  storage: new Set(["ls"]),
  backups: new Set(["list"]),
}
// These change only the local database unless pointed at the linked one.
const SUPABASE_LOCAL_BY_DEFAULT = new Set(["db reset", "migration up", "migration down", "migration squash", "seed"])
// These change the linked project unless told to use the local one.
const SUPABASE_REMOTE_BY_DEFAULT = new Set(["db push", "migration repair", "storage cp", "storage mv", "storage rm"])

function supabase(args: string[]): Request | undefined {
  const [sub, second] = words(args, SUPABASE_VALUE_FLAGS)
  if (!sub) return
  if (SUPABASE_LOCAL.has(sub)) return
  if (second && SUPABASE_LOCAL_SECOND[sub]?.has(second)) return
  const action = [sub, second].filter(Boolean).join(" ")
  const remoteFlag = args.some(
    (arg) => arg === "--linked" || arg.startsWith("--db-url") || arg.startsWith("--project-ref"),
  )
  if (SUPABASE_LOCAL_BY_DEFAULT.has(action) || SUPABASE_LOCAL_BY_DEFAULT.has(sub)) {
    if (!remoteFlag) return
  }
  if (SUPABASE_REMOTE_BY_DEFAULT.has(action) && args.includes("--local")) return
  // Project settings read with get or list return no data or keys, except the
  // root key encryption reveals.
  if (second && READS.has(second) && sub !== "projects" && sub !== "branches" && sub !== "encryption") return
  return {
    permission: "vector_cloud_database",
    provider: "Supabase",
    environment: "linked project",
    action,
    summary: "change the Supabase project or account, or read its data or keys",
  }
}
