import { execFile } from "node:child_process"
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"

// How a linked Supabase project lands in a repository: which public variable
// names the framework's bundler actually exposes to browser code, the client
// file the app imports, and keeping the .env Vector writes out of git. Only the
// filesystem is touched here, so cloud-console can use it without a cycle.

export type SupabaseFramework = "next" | "astro" | "expo" | "cra" | "vite" | "other"

export type SupabaseClientScaffold = {
  path: string
  created: boolean
  /** The app does not depend on @supabase/supabase-js yet, so the client will not import until it does. */
  dependencyMissing: boolean
}

// Checked in this order: Astro and Expo projects can list vite or react too.
export async function supabaseFramework(directory: string): Promise<SupabaseFramework> {
  const dependencies = await readDependencies(directory)
  if ("next" in dependencies) return "next"
  if ("astro" in dependencies) return "astro"
  if ("expo" in dependencies) return "expo"
  if ("react-scripts" in dependencies) return "cra"
  if ("vite" in dependencies) return "vite"
  return "other"
}

// Each bundler inlines only its own prefix into browser code, and only through
// its own accessor. Anything else gets plain names, which browser code cannot
// read until they are renamed to its bundler's prefix.
// https://nextjs.org/docs/app/guides/environment-variables#bundling-environment-variables-for-the-browser
// https://docs.astro.build/en/guides/environment-variables/
// https://docs.expo.dev/guides/environment-variables/
// https://create-react-app.dev/docs/adding-custom-environment-variables/
// https://vite.dev/guide/env-and-mode#env-variables
const PUBLIC_ENV: Record<SupabaseFramework, { prefix: string; accessor: string }> = {
  next: { prefix: "NEXT_PUBLIC_", accessor: "process.env" },
  astro: { prefix: "PUBLIC_", accessor: "import.meta.env" },
  expo: { prefix: "EXPO_PUBLIC_", accessor: "process.env" },
  cra: { prefix: "REACT_APP_", accessor: "process.env" },
  vite: { prefix: "VITE_", accessor: "import.meta.env" },
  other: { prefix: "", accessor: "process.env" },
}

export function supabasePublicEnvNames(framework: SupabaseFramework) {
  const prefix = PUBLIC_ENV[framework].prefix
  return { url: `${prefix}SUPABASE_URL`, key: `${prefix}SUPABASE_ANON_KEY` }
}

// What to tell the user when Vector could not tell which names browser code reads.
export function supabaseEnvNote(framework: SupabaseFramework) {
  if (framework !== "other") return
  return "Vector wrote SUPABASE_URL and SUPABASE_ANON_KEY because it did not recognise the framework. If browser code reads them, rename them to the prefix its bundler exposes (for example PUBLIC_, REACT_APP_ or EXPO_PUBLIC_) and update the generated client."
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
  // A bundler only inlines the exact `process.env.NAME` text, so the known
  // frameworks read it bare; anything else may run where process is undefined.
  const read = (name: string) =>
    framework === "other"
      ? `typeof process === "undefined" ? undefined : process.env.${name}`
      : `${PUBLIC_ENV[framework].accessor}.${name}`
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
// the .gitignore lines are checked directly. git never reports a tracked file
// as ignored, and an ignore line cannot untrack it, so a tracked .env gets no
// line added; `envTracked` is what callers check before writing a secret.
export async function ensureEnvIgnored(directory: string): Promise<{ added: boolean; tracked: boolean }> {
  if (await envTracked(directory)) return { added: false, tracked: true }
  const ignored = await git(directory, ["check-ignore", "-q", ".env"])
  if (ignored === true) return { added: false, tracked: false }
  const path = join(directory, ".gitignore")
  const existing = await lstat(path).catch(() => undefined)
  if (existing && !existing.isFile()) throw new Error("The project's .gitignore must be a regular file.")
  const text = existing ? await readFile(path, "utf8") : ""
  if (ignored === undefined && /^\s*\/?(?:\.env|\.env\*|\*\.env|\.env\.?\*)\s*$/m.test(text)) {
    return { added: false, tracked: false }
  }
  const separator = text && !text.endsWith("\n") ? "\n" : ""
  await writeFile(
    path,
    `${text}${separator}${text ? "\n" : ""}# Local environment written by Vector Cloud\n.env\n`,
    "utf8",
  )
  return { added: true, tracked: false }
}

// Whether git already tracks this repository's .env, so writing a secret there
// would put it in the next commit.
export async function envTracked(directory: string) {
  return (await git(directory, ["ls-files", "--error-unmatch", "--", ".env"])) === true
}

// true on exit 0, false on exit 1, undefined when this is not a repository or
// git is missing.
function git(directory: string, args: string[]) {
  return new Promise<boolean | undefined>((done) =>
    execFile("git", args, { cwd: directory, env: untrustedChildEnvironment(), timeout: 5_000 }, (error) =>
      done(!error ? true : error.code === 1 ? false : undefined),
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
