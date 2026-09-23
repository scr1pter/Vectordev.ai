#!/usr/bin/env bun
import path from "node:path"
import { readdir, realpath } from "node:fs/promises"

const root = path.resolve(import.meta.dirname, "..")
const visited = new Set<string>()
const entries: { name: string; version: string; license: string; texts: string[] }[] = []
const missing: string[] = []

async function resolvePackage(name: string, from: string) {
  for (const dir of ancestors(from)) {
    const candidate = path.join(dir, "node_modules", name)
    if (await Bun.file(path.join(candidate, "package.json")).exists()) return realpath(candidate)
  }
}

function ancestors(from: string): string[] {
  const parent = path.dirname(from)
  return parent === from ? [from] : [from, ...ancestors(parent)]
}

async function visit(dir: string) {
  if (visited.has(dir)) return
  visited.add(dir)
  const pkg = await Bun.file(path.join(dir, "package.json")).json()
  const workspace = dir.startsWith(path.join(root, "packages") + path.sep)
  const files = await readdir(dir, { withFileTypes: true })
  const licenses = files.filter(
    (file) => file.isFile() && /^(licen[cs]e|copying|notice|copyright)([.\-_]|$)/i.test(file.name),
  )
  const texts = await Promise.all(
    licenses
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (file) => `### ${file.name}\n\n${(await Bun.file(path.join(dir, file.name)).text()).trim()}`),
  )
  if (!workspace) {
    if (!texts.length) {
      const override = path.join(
        root,
        "licenses",
        "dependencies",
        `${pkg.name.replaceAll("/", "__")}@${pkg.version}.txt`,
      )
      if (await Bun.file(override).exists()) texts.push(await Bun.file(override).text())
      if (!texts.length) missing.push(`${pkg.name}@${pkg.version}: ${dir}`)
    }
    entries.push({
      name: pkg.name,
      version: pkg.version,
      license:
        typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? "Not declared"),
      texts,
    })
  }
  const runtime = new Set<string>(Object.keys(pkg.dependencies ?? {}))
  Object.keys(pkg.optionalDependencies ?? {}).forEach((name) => runtime.add(name))
  if (workspace) {
    // Some workspaces classify renderer imports as development dependencies. Include the ones actually imported by source.
    for await (const file of new Bun.Glob("src/**/*.{ts,tsx,js,jsx,mjs,css}").scan(dir)) {
      if (/\.(test|spec|stories)\./.test(file)) continue
      const source = await Bun.file(path.join(dir, file)).text()
      Object.keys(pkg.devDependencies ?? {})
        .filter((name) => source.includes(`"${name}`) || source.includes(`'${name}`))
        .forEach((name) => runtime.add(name))
    }
    if (pkg.name === "vector-desktop") runtime.add("electron")
  }
  for (const name of [...runtime].sort()) {
    const next = await resolvePackage(name, dir)
    if (next) await visit(next)
    if (!next && !(name in (pkg.optionalDependencies ?? {})))
      throw new Error(`Missing installed runtime dependency ${name} of ${pkg.name}`)
  }
}

for (const name of ["engine", "app", "desktop", "tui", "ui"]) await visit(path.join(root, "packages", name))
if (missing.length)
  throw new Error(
    `Missing license texts (add exact upstream notices under licenses/dependencies):\n${missing.join("\n")}`,
  )
const unique = [...new Map(entries.map((entry) => [`${entry.name}@${entry.version}`, entry])).values()].sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
)
await Bun.write(
  path.join(root, "DEPENDENCY_NOTICES.md"),
  [
    "# Vector bundled dependency notices",
    "Generated from the installed runtime dependency closure of Vector's engine, embedded UI, TUI and desktop. Includes bundled JavaScript and external native packages; optional packages installed for other release platforms are included. Vector's own notices, vendored assets and runtimes are covered in THIRD_PARTY_NOTICES.md. Individual component licenses remain authoritative.",
    ...unique.map(
      (entry) => `## ${entry.name}@${entry.version}\n\nLicense: ${entry.license}\n\n${entry.texts.join("\n\n")}`,
    ),
    "",
  ].join("\n\n"),
)
console.log(`Generated notices for ${unique.length} packages`)
