export * as CloudCli from "./cloud-cli"

import path from "node:path"

// Vercel and Supabase command-line calls that act on the user's cloud accounts.
// vector_cloud asks for the same work every time, under a permission that
// auto-accept, permission rules and earlier approvals never answer
// (PermissionPolicy). Typed into the shell instead, it would run on the CLI's
// own login without a prompt, so the shell asks under that same permission.
// This is a best-effort reading of the command line: it sees the CLI behind
// wrappers, package runners and `sh -c` strings (`script`), but not behind a
// project script (`npm run deploy`), a variable (`$CLI --prod`) or a program
// that calls the API itself. Only the shell sandbox, which hides the CLI
// logins, closes those routes.

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
  if (!invocation || "script" in invocation) return
  if (invocation.cli === "vercel") return vercel(invocation.args)
  return supabase(invocation.args)
}

/**
 * The command line a command runs from a string, such as `sh -c "vercel --prod"`,
 * `eval vercel --prod` or `watch 'supabase db push'`. The shell parses it and
 * checks each command in it as its own.
 */
export function script(tokens: readonly string[]): string | undefined {
  const invocation = unwrap(tokens.map(unquote))
  if (invocation && "script" in invocation) return invocation.script
}

type Invocation = { cli: "vercel" | "supabase"; args: string[] } | { script: string }

// Programs that run the command after them, with their options that take a
// value, and how many plain arguments come before the command (`timeout 300 vercel`).
const WRAPPERS: Record<string, { values: Set<string>; positional?: number }> = {
  env: { values: new Set(["-u", "--unset", "-C", "--chdir"]) },
  time: { values: new Set(["-f", "--format", "-o", "--output"]) },
  nohup: { values: new Set() },
  exec: { values: new Set(["-a"]) },
  command: { values: new Set() },
  sudo: {
    values: new Set(["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "-D", "--chdir"]),
  },
  doas: { values: new Set(["-u", "-C"]) },
  timeout: { values: new Set(["-s", "--signal", "-k", "--kill-after"]), positional: 1 },
  gtimeout: { values: new Set(["-s", "--signal", "-k", "--kill-after"]), positional: 1 },
  nice: { values: new Set(["-n", "--adjustment"]) },
  ionice: { values: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]) },
  xargs: {
    values: new Set([
      "-I",
      "-J",
      "-L",
      "-n",
      "-P",
      "-R",
      "-S",
      "-s",
      "-d",
      "-E",
      "-a",
      "--max-args",
      "--max-procs",
      "--max-lines",
      "--max-chars",
      "--delimiter",
      "--arg-file",
      "--eof",
      "--process-slot-var",
    ]),
  },
  caffeinate: { values: new Set(["-t", "-w"]) },
  stdbuf: { values: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]) },
  chronic: { values: new Set() },
  unbuffer: { values: new Set() },
  setsid: { values: new Set() },
  // Package runners that run a package's binary: `npx --yes vercel@59 deploy`.
  // Their `-c` runs a command line, which the quoted-program rule below reads.
  npx: { values: new Set(["-p", "--package"]) },
  bunx: { values: new Set(["-p", "--package"]) },
  pnpx: { values: new Set(["-p", "--package"]) },
}
// Package managers that run a project or package binary after a verb, with the
// options that may come before or after the verb and take a value:
// `pnpm --filter web exec vercel`, `npm --prefix web exec vercel`.
const RUNNERS: Record<string, { verbs: Set<string>; values: Set<string> }> = {
  npm: { verbs: new Set(["exec", "x"]), values: new Set(["--prefix", "-C", "-w", "--workspace", "-p", "--package"]) },
  pnpm: {
    verbs: new Set(["dlx", "exec"]),
    values: new Set(["--filter", "-F", "-C", "--dir", "--workspace-dir", "--package"]),
  },
  yarn: { verbs: new Set(["dlx", "exec", "run"]), values: new Set(["--cwd", "-p", "--package"]) },
  bun: { verbs: new Set(["x", "run"]), values: new Set(["--cwd", "-c", "--config", "--env-file", "-r", "--preload"]) },
}
// Shells whose `-c` runs the argument after it as a command line.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])
const SHELL_VALUE_FLAGS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"])
const WATCH_VALUE_FLAGS = new Set(["-n", "--interval", "-d", "--differences", "-q", "--equexit"])
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"])

function unwrap(tokens: string[]): Invocation | undefined {
  const [first, ...rest] = tokens
  if (!first) return
  const name = program(first)
  if (name === "vercel" || name === "vc") return { cli: "vercel", args: rest }
  if (name === "supabase") return { cli: "supabase", args: rest }
  // `eval` and `watch` join their arguments into one command line.
  if (name === "eval") return { script: rest.join(" ") }
  if (name === "watch") return { script: skipOptions(rest, WATCH_VALUE_FLAGS).join(" ") }
  if (SHELLS.has(name)) return shell(rest, false)
  if (name === "find") return find(rest)
  // `command -v vercel` only looks the program up.
  if (name === "command" && (rest[0] === "-v" || rest[0] === "-V")) return
  const wrapper = WRAPPERS[name]
  if (wrapper) return unwrap(skipOptions(rest, wrapper.values).slice(wrapper.positional ?? 0))
  const runner = RUNNERS[name]
  if (runner) return run(rest, runner)
  // A command line passed as one quoted program, as `env -S`, `npx -c` and
  // `pnpm -c exec` run it.
  if (/\s/.test(first)) return { script: tokens.join(" ") }
}

function run(tokens: string[], runner: { verbs: Set<string>; values: Set<string> }) {
  const rest = skipOptions(tokens, runner.values)
  const next = rest[0] ? program(rest[0]) : ""
  // `pnpm vercel`, `yarn supabase` and `bun vercel` run a project binary too.
  if (next === "vercel" || next === "vc" || next === "supabase") return unwrap(rest)
  if (!runner.verbs.has(next)) return
  return unwrap(skipOptions(rest.slice(1), runner.values))
}

// `bash -lc "vercel --prod"` runs its argument; `bash deploy.sh` runs a file,
// which is not read here.
function shell(tokens: string[], command: boolean): Invocation | undefined {
  const [first, ...rest] = tokens
  if (first === undefined) return
  if (first === "--") return command && rest[0] !== undefined ? { script: rest[0] } : undefined
  // `-o pipefail`, and a cluster ending in o such as `-euo pipefail`.
  if (SHELL_VALUE_FLAGS.has(first) || /^[-+][A-Za-z]*[oO]$/.test(first)) return shell(rest.slice(1), command)
  if (first === "--command") return rest[0] !== undefined ? { script: rest[0] } : undefined
  if (first.startsWith("-") || first.startsWith("+"))
    return shell(rest, command || /^-[A-Za-z]*c[A-Za-z]*$/.test(first))
  return command ? { script: first } : undefined
}

// `find . -exec vercel deploy {} \;` runs the command after -exec for each file.
function find(tokens: string[]) {
  return tokens.reduce<Invocation | undefined>((found, token, index) => {
    if (found || !FIND_EXEC.has(token)) return found
    const rest = tokens.slice(index + 1)
    const end = rest.findIndex((item) => item === ";" || item === "\;" || item === "+")
    return unwrap(end === -1 ? rest : rest.slice(0, end))
  }, undefined)
}

function skipOptions(tokens: string[], values: ReadonlySet<string>): string[] {
  const [first, ...rest] = tokens
  if (first === undefined) return []
  if (first === "--") return rest
  // `env NAME=value cmd`
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return skipOptions(rest, values)
  if (!first.startsWith("-") || first === "-") return tokens
  if (values.has(first)) return skipOptions(rest.slice(1), values)
  return skipOptions(rest, values)
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
const HELP_FLAGS = new Set(["-h", "--help"])
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
// Run on this machine or only read: no account changes. `dev` and `build`
// can download the project's variables, so they are read in vercel() below.
const VERCEL_LOCAL = new Set([
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
  if (help(args)) return
  if (sub && VERCEL_LOCAL.has(sub)) return
  // `vercel dev` downloads the Development variables into the server it runs.
  if (sub === "dev") {
    return {
      permission: "vector_cloud_environment",
      provider: "Vercel",
      environment: "development",
      action: "dev",
      summary:
        "run the project on this machine with its Development environment variables, secrets included, downloaded from Vercel",
    }
  }
  if (sub === "build") {
    // With --yes, a build without project settings on this machine first runs
    // `vercel pull`, writing that environment's variables into .vercel.
    if (!args.some((arg) => arg === "--yes" || arg === "-y")) return
    const environment = isProduction(args) ? "production" : "preview"
    return {
      permission: "vector_cloud_environment",
      provider: "Vercel",
      environment,
      action: "build",
      summary: `build the project, first writing its ${environment} environment variables, secrets included, into .vercel when its settings are not on this machine`,
    }
  }
  // `vercel`, `vercel --prod` and `vercel <dir>` deploy, as `vercel deploy` does.
  if (!sub || sub === "deploy" || !KNOWN_VERCEL.has(sub)) {
    const production = isProduction(args)
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

function isProduction(args: string[]) {
  return args.some(
    (arg, index) =>
      arg === "--prod" || arg === "--target=production" || (arg === "--target" && args[index + 1] === "production"),
  )
}

// Help prints usage and changes nothing (`vercel deploy --help`). After `--`
// the words belong to the command the CLI runs.
function help(args: string[]) {
  const end = args.indexOf("--")
  return (end === -1 ? args : args.slice(0, end)).some((arg) => HELP_FLAGS.has(arg))
}

// Subcommands the Vercel CLI has; any other first word is a folder to deploy.
const KNOWN_VERCEL = new Set([
  ...VERCEL_LOCAL,
  "dev",
  "build",
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
  "inspect",
  "services",
  "login",
  "logout",
])
// Second words that only work on this machine or only read.
const SUPABASE_LOCAL_SECOND: Record<string, Set<string>> = {
  test: new Set(["new"]),
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
// These change or read only the local database unless pointed at the linked
// one: `supabase test db --linked` runs its SQL tests against the linked database.
const SUPABASE_LOCAL_BY_DEFAULT = new Set([
  "db reset",
  "migration up",
  "migration down",
  "migration squash",
  "seed",
  "test db",
])
// These change the linked project unless told to use the local one.
const SUPABASE_REMOTE_BY_DEFAULT = new Set(["db push", "migration repair", "storage cp", "storage mv", "storage rm"])

function supabase(args: string[]): Request | undefined {
  const [sub, second] = words(args, SUPABASE_VALUE_FLAGS)
  if (!sub || help(args)) return
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
