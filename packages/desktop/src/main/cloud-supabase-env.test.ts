import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ensureEnvIgnored,
  projectRefFromUrl,
  scaffoldSupabaseClient,
  supabaseFramework,
  supabasePublicEnvNames,
} from "./cloud-supabase-env"

let directory = ""

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vector-supabase-env-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const manifest = (dependencies: Record<string, string>) =>
  writeFile(join(directory, "package.json"), JSON.stringify({ dependencies }))

describe("public Supabase names per framework", () => {
  test("Next.js gets NEXT_PUBLIC_*, Vite gets VITE_*, anything else plain names", async () => {
    expect(await supabaseFramework(directory)).toBe("other")
    await manifest({ next: "15.0.0", react: "19.0.0" })
    expect(await supabaseFramework(directory)).toBe("next")
    await writeFile(join(directory, "package.json"), JSON.stringify({ devDependencies: { vite: "6.0.0" } }))
    expect(await supabaseFramework(directory)).toBe("vite")
    expect(supabasePublicEnvNames("next")).toEqual({
      url: "NEXT_PUBLIC_SUPABASE_URL",
      key: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    })
    expect(supabasePublicEnvNames("vite")).toEqual({ url: "VITE_SUPABASE_URL", key: "VITE_SUPABASE_ANON_KEY" })
    expect(supabasePublicEnvNames("other")).toEqual({ url: "SUPABASE_URL", key: "SUPABASE_ANON_KEY" })
  })

  test("derives the project reference from a hosted project URL only", () => {
    expect(projectRefFromUrl("https://abcdefghijklmnopqrst.supabase.co")).toBe("abcdefghijklmnopqrst")
    expect(projectRefFromUrl("https://db.example.com")).toBeUndefined()
    expect(projectRefFromUrl("not a url")).toBeUndefined()
  })
})

describe("client scaffold", () => {
  test("writes a TypeScript Next.js client reading NEXT_PUBLIC_* when tsconfig.json exists", async () => {
    await manifest({ next: "15.0.0", "@supabase/supabase-js": "2.0.0" })
    await writeFile(join(directory, "tsconfig.json"), "{}")
    const scaffold = await scaffoldSupabaseClient(directory, "next")
    expect(scaffold).toEqual({ path: join("lib", "supabase.ts"), created: true, dependencyMissing: false })
    const source = await readFile(join(directory, "lib", "supabase.ts"), "utf8")
    expect(source).toContain("process.env.NEXT_PUBLIC_SUPABASE_URL")
    expect(source).toContain("process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY")
    expect(source).not.toContain("import.meta")
  })

  test("writes a JavaScript Vite client under src/lib and says the package is missing", async () => {
    await manifest({ vite: "6.0.0" })
    const scaffold = await scaffoldSupabaseClient(directory, "vite")
    expect(scaffold).toEqual({ path: join("src", "lib", "supabase.js"), created: true, dependencyMissing: true })
    expect(await readFile(join(directory, "src", "lib", "supabase.js"), "utf8")).toContain(
      "import.meta.env.VITE_SUPABASE_URL",
    )
  })

  test("never replaces a client the project already has, in either language", async () => {
    await mkdir(join(directory, "src", "lib"), { recursive: true })
    await writeFile(join(directory, "src", "lib", "supabase.js"), "// mine")
    await writeFile(join(directory, "tsconfig.json"), "{}")
    const scaffold = await scaffoldSupabaseClient(directory, "other")
    expect(scaffold).toMatchObject({ path: join("src", "lib", "supabase.js"), created: false })
    expect(await readFile(join(directory, "src", "lib", "supabase.js"), "utf8")).toBe("// mine")
  })
})

describe(".env stays out of git", () => {
  test("adds .env to a repository's .gitignore once, and leaves an ignoring one alone", async () => {
    execFileSync("git", ["init", "-q"], { cwd: directory })
    await writeFile(join(directory, ".gitignore"), "node_modules")
    expect(await ensureEnvIgnored(directory)).toEqual({ added: true })
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe(
      "node_modules\n\n# Local environment written by Vector Cloud\n.env\n",
    )
    expect(await ensureEnvIgnored(directory)).toEqual({ added: false })
  })

  test("respects a broader rule git already applies", async () => {
    execFileSync("git", ["init", "-q"], { cwd: directory })
    await writeFile(join(directory, ".gitignore"), ".env*\n")
    expect(await ensureEnvIgnored(directory)).toEqual({ added: false })
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe(".env*\n")
  })

  test("outside a repository it reads .gitignore itself and creates one when missing", async () => {
    expect(await ensureEnvIgnored(directory)).toEqual({ added: true })
    expect(await readFile(join(directory, ".gitignore"), "utf8")).toBe(
      "# Local environment written by Vector Cloud\n.env\n",
    )
    expect(await ensureEnvIgnored(directory)).toEqual({ added: false })
  })
})
