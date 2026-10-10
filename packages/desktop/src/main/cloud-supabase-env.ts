import { execFile } from "node:child_process"
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

// How a linked Supabase project lands in a repository: which public variable
// names the framework's bundler actually exposes to browser code, the client
// file the app imports, and keeping the .env Vector writes out of git. Only the
// filesystem is touched here, so cloud-console can use it without a cycle.

export type SupabaseFramework = "next" | "vite" | "other"

export type SupabaseClientScaffold = {
  path: string
  created: boolean
  /** The app does not depend on @supabase/supabase-js yet, so the client will not import until it does. */
  dependencyMissing: boolean
}

export async function supabaseFramework(directory: string): Promise<SupabaseFramework> {
  const dependencies = await readDependencies(directory)
  if ("next" in dependencies) return "next"
  if ("vite" in dependencies) return "vite"
  return "other"
}

// Next.js only inlines NEXT_PUBLIC_* into client bundles and Vite only VITE_*;
// anything else reads plain names from its own runtime environment.
// https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser
// https://vite.dev/guide/env-and-mode#env-variables
export function supabasePublicEnvNames(framework: SupabaseFramework) {
  if (framework === "next") return { url: "NEXT_PUBLIC_SUPABASE_URL", key: "NEXT_PUBLIC_SUPABASE_ANON_KEY" }
  if (framework === "vite") return { url: "VITE_SUPABASE_URL", key: "VITE_SUPABASE_ANON_KEY" }
  return { url: "SUPABASE_URL", key: "SUPABASE_ANON_KEY" }
}

// Hosted projects are served from https://<ref>.supabase.co, which is how an
// older record that never stored its reference still finds its project.
export function projectRefFromUrl(url: string): string | undefined {
  if (!URL.canParse(url)) return
  return new URL(url).hostname.match(/^([a-z0-9][a-z0-9-]*)\.supabase\.(?:co|in)$/)?.[1]
}

// Never overwrites: a client the user already has (in either language) wins.
export async function scaffoldSupabaseClient(
  directory: string,
  framework: SupabaseFramework,
): Promise<SupabaseClientScaffold> {
  const dependencies = await readDependencies(directory)
  const hasSrc = Boolean((await stat(join(directory, "src")).catch(() => undefined))?.isDirectory())
  const folder = framework === "next" && !hasSrc ? "lib" : join("src", "lib")
  const typescript = Boolean(await stat(join(directory, "tsconfig.json")).catch(() => undefined))
  const relative = join(folder, typescript ? "supabase.ts" : "supabase.js")
  const dependencyMissing = !("@supabase/supabase-js" in dependencies)
  for (const existing of ["supabase.ts", "supabase.js"]) {
    if (await stat(join(directory, folder, existing)).catch(() => undefined)) {
      return { path: join(folder, existing), created: false, dependencyMissing }
    }
  }
  await mkdir(join(directory, folder), { recursive: true })
  await writeFile(join(directory, relative), supabaseClientSource(framework), { encoding: "utf8", flag: "wx" })
  return { path: relative, created: true, dependencyMissing }
}

function supabaseClientSource(framework: SupabaseFramework) {
  const names = supabasePublicEnvNames(framework)
  const read = (name: string) => (framework === "vite" ? `import.meta.env.${name}` : `process.env.${name}`)
  return `import { createClient } from "@supabase/supabase-js"

// Vector-managed Supabase client. The values are set in Vector Cloud and written
// to .env; they are the project's public URL and publishable (anon) key.
const supabaseUrl = ${read(names.url)}
const supabaseKey = ${read(names.key)}

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Supabase is not configured: set ${names.url} and ${names.key} in Vector Cloud.")
}

export const supabase = createClient(supabaseUrl, supabaseKey)
`
}

// Vector writes database credentials into .env, so it must not be committed.
// git's own answer covers nested and global ignore rules; outside a repository
// the .gitignore lines are checked directly.
export async function ensureEnvIgnored(directory: string): Promise<{ added: boolean }> {
  const ignored = await gitIgnores(directory, ".env")
  if (ignored === true) return { added: false }
  const path = join(directory, ".gitignore")
  const existing = await lstat(path).catch(() => undefined)
  if (existing && !existing.isFile()) throw new Error("The project's .gitignore must be a regular file.")
  const text = existing ? await readFile(path, "utf8") : ""
  if (ignored === undefined && /^\s*\/?(?:\.env|\.env\*|\*\.env|\.env\.?\*)\s*$/m.test(text)) return { added: false }
  const separator = text && !text.endsWith("\n") ? "\n" : ""
  await writeFile(path, `${text}${separator}${text ? "\n" : ""}# Local environment written by Vector Cloud\n.env\n`, "utf8")
  return { added: true }
}

function gitIgnores(directory: string, file: string) {
  return new Promise<boolean | undefined>((done) =>
    execFile(
      "git",
      ["check-ignore", "-q", file],
      { cwd: directory, env: untrustedChildEnvironment(), timeout: 5_000 },
      // 0: ignored, 1: not ignored, anything else: not a repository or no git.
      (error) => done(!error ? true : error.code === 1 ? false : undefined),
    ),
  )
}

async function readDependencies(directory: string): Promise<Record<string, unknown>> {
  const manifest: unknown = await readFile(join(directory, "package.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  if (!manifest || typeof manifest !== "object") return {}
  const pick = (key: string) => {
    const value = Reflect.get(manifest, key)
    return value && typeof value === "object" ? value : {}
  }
  return { ...pick("dependencies"), ...pick("devDependencies") }
}
