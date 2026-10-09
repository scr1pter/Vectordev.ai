#!/usr/bin/env bun
import path from "node:path"
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import os from "node:os"

type Entry = { name: string; version: string; license: string; texts: string[] }
type PlatformEntry = Entry & { integrity: string; source: string; override?: string }
type BundledEntry = {
  name: string
  version: string
  integrity: string
  source: string
  publisherCommit: string
  publisherLock: string
  components: (PlatformEntry & { textSha256: string; publisherPath: string })[]
}
type Locked = [
  string,
  string,
  { os?: unknown; cpu?: unknown; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> },
  string?,
]

export async function dependencyNotices(root: string, refreshPlatforms = false) {
  const lock = Bun.JSON5.parse(await Bun.file(path.join(root, "bun.lock")).text()) as {
    packages: Record<string, Locked>
    workspaces: Record<string, unknown>
    catalog?: Record<string, string>
    overrides?: Record<string, string>
  }
  const inventoryFile = path.join(root, "licenses/dependencies/platform-notices.json")
  const inventory: Record<string, PlatformEntry> = await Bun.file(inventoryFile)
    .json()
    .catch(() => ({}))
  const bundledFile = Bun.file(path.join(root, "licenses/dependencies/bundled-provider-notices.json"))
  const bundled: Record<string, BundledEntry> = (await bundledFile.exists()) ? await bundledFile.json() : {}
  if (!bundled || typeof bundled !== "object" || Array.isArray(bundled))
    throw new Error("Invalid bundled provider notice inventory")
  // These published SDKs embed dependency code outside the installer's graph.
  // Removing their inventory must not silently remove their embedded notices.
  const requiredBundles = new Set(["@jerome-benoit/sap-ai-provider", "merge-gateway-ai-sdk-provider"])
  const workspaces = new Set(
    await Promise.all(Object.keys(lock.workspaces).map((directory) => realpath(path.resolve(root, directory)))),
  )
  const usedBundles = new Set<string>()
  const lockedPackages = new Map<string, Locked[]>()
  const lockedParents = new Map<string, string[]>()
  for (const [key, entry] of Object.entries(lock.packages)) {
    const name = entry[0].slice(0, entry[0].lastIndexOf("@"))
    lockedPackages.set(name, [...(lockedPackages.get(name) ?? []), entry])
    lockedParents.set(entry[0], [...(lockedParents.get(entry[0]) ?? []), key])
  }
  const platforms = new Map<string, PlatformEntry>()
  const visited = new Set<string>()
  const entries: Entry[] = []
  const missing: string[] = []
  const overrides = new Set<string>()

  async function resolvePackage(name: string, from: string, identity = name) {
    const entry = await Promise.resolve()
      .then(() => Bun.resolveSync(name, from))
      .catch(() => undefined)
    if (entry && path.isAbsolute(entry)) {
      const roots: string[] = []
      for (const dir of ancestors(path.dirname(entry))) {
        const manifest = Bun.file(path.join(dir, "package.json"))
        if (!(await manifest.exists()) || (await manifest.json()).name !== identity) continue
        roots.push(dir)
        if ([name, identity].some((name) => dir.endsWith(path.sep + path.join("node_modules", name))))
          return realpath(dir)
      }
      // Some packages repeat their manifest in build directories; notices live at the package root.
      if (roots.length) return realpath(roots[roots.length - 1])
    }
    // Type-only packages and packages shadowed by Bun built-ins may have no file entry point.
    for (const dir of ancestors(from)) {
      const candidate = path.join(dir, "node_modules", name)
      if (await Bun.file(path.join(candidate, "package.json")).exists()) return realpath(candidate)
    }
  }

  function platformLock(name: string, range: string, parent?: { name: string; version?: string }, platform = true) {
    const version = range === "catalog:" ? lock.catalog?.[name] : range
    const matches = [
      ...new Map(
        (lockedPackages.get(name) ?? [])
          .filter(
            (entry) =>
              (!platform || entry[2]?.os || entry[2]?.cpu) &&
              entry[0].startsWith(`${name}@`) &&
              (entry[0] === `${name}@${version}` ||
                (version && Bun.semver.satisfies(entry[0].slice(name.length + 1), version))),
          )
          .map((entry) => [entry[0], entry]),
      ).values(),
    ]
    if (matches.length < 2) return matches[0]
    const resolved = (lockedParents.get(`${parent?.name}@${parent?.version}`) ?? [])
      .map((key) => {
        const prefixes = [
          key,
          ...key
            .split("/")
            .map((_, index, all) => all.slice(0, index).join("/"))
            .reverse(),
        ]
        return prefixes
          .map((prefix) => lock.packages[prefix ? `${prefix}/${name}` : name])
          .find((entry) => entry && matches.some((match) => match[0] === entry[0]))
      })
      .filter((entry): entry is Locked => !!entry)
    if (resolved.length && resolved.every((entry) => entry[0] === resolved[0][0])) return resolved[0]
    if (!resolved.length && matches.some((match) => match[0] === lock.packages[name]?.[0])) return lock.packages[name]
    throw new Error(`Ambiguous locked platform dependency ${name}@${range}`)
  }

  async function legal(dir: string): Promise<Entry & { override?: string }> {
    const pkg = await Bun.file(path.join(dir, "package.json")).json()
    const files = (await readdir(dir, { withFileTypes: true })).filter(
      (file) => file.isFile() && /^(licen[cs]e|copying|notice|copyright)([.\-_]|$)/i.test(file.name),
    )
    const texts = await Promise.all(
      files
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (file) => `### ${file.name}\n\n${(await Bun.file(path.join(dir, file.name)).text()).trim()}`),
    )
    const override = `${pkg.name.replaceAll("/", "__")}@${pkg.version}.txt`
    if (!texts.length && (await Bun.file(path.join(root, "licenses/dependencies", override)).exists())) {
      texts.push(await Bun.file(path.join(root, "licenses/dependencies", override)).text())
      overrides.add(override)
    }
    if (!texts.length) missing.push(`${pkg.name}@${pkg.version}: ${dir}`)
    return {
      name: pkg.name,
      version: pkg.version,
      license:
        typeof pkg.license === "string" ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? "Not declared"),
      texts,
      ...(overrides.has(override) ? { override } : {}),
    }
  }

  function includeBundled(pkg: { name: string; version: string }) {
    const identity = `${pkg.name}@${pkg.version}`
    const record = bundled[identity]
    if (!record) {
      if (requiredBundles.has(pkg.name)) throw new Error(`Missing bundled provider notices for ${identity}`)
      return
    }
    if (usedBundles.has(identity)) return
    const locked = lockedPackages.get(pkg.name)?.filter((entry) => entry[0] === identity)
    if (
      record.name !== pkg.name ||
      record.version !== pkg.version ||
      !locked?.length ||
      locked.some((entry) => entry[3] !== record.integrity) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(record.integrity) ||
      record.source !== `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/").at(-1)}-${pkg.version}.tgz` ||
      !/^[a-f0-9]{40}$/.test(record.publisherCommit) ||
      typeof record.publisherLock !== "string" ||
      !record.publisherLock.startsWith("https://raw.githubusercontent.com/") ||
      !record.publisherLock.endsWith(`/${record.publisherCommit}/package-lock.json`) ||
      !Array.isArray(record.components) ||
      !record.components.length
    )
      throw new Error(
        `Missing or stale bundled provider notices for ${identity}; verify the exact publisher artifact again`,
      )
    const seen = new Set<string>()
    for (const component of record.components) {
      const name = `${component.name}@${component.version}`
      if (
        typeof component.name !== "string" ||
        !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(component.name) ||
        typeof component.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(component.version) ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(component.integrity) ||
        component.source !==
          `https://registry.npmjs.org/${component.name}/-/${component.name.split("/").at(-1)}-${component.version}.tgz` ||
        typeof component.publisherPath !== "string" ||
        !component.publisherPath.endsWith(`node_modules/${component.name}`) ||
        typeof component.license !== "string" ||
        !component.license.trim() ||
        !Array.isArray(component.texts) ||
        !component.texts.length ||
        component.texts.some((text) => typeof text !== "string" || !text.trim()) ||
        component.textSha256 !== new Bun.CryptoHasher("sha256").update(JSON.stringify(component.texts)).digest("hex") ||
        seen.has(name)
      )
        throw new Error(`Invalid bundled component notice for ${name} in ${identity}`)
      seen.add(name)
      entries.push(component)
    }
    usedBundles.add(identity)
  }

  async function visitPlatform(locked: Locked, from: string, installed?: string) {
    const identity = locked[0]
    if (visited.has(identity)) return
    visited.add(identity)
    const split = identity.lastIndexOf("@")
    const name = identity.slice(0, split)
    const version = identity.slice(split + 1)
    if (!locked[3]?.startsWith("sha512-")) throw new Error(`Platform dependency has no locked integrity: ${identity}`)
    if (refreshPlatforms && installed) {
      const actual = await Bun.file(path.join(installed, "package.json")).json()
      if (actual.name !== name || actual.version !== version) installed = undefined
    }
    if (refreshPlatforms && !installed) {
      for await (const candidate of new Bun.Glob(
        `node_modules/.bun/${name.replaceAll("/", "+")}@${version}*/node_modules/${name}/package.json`,
      ).scan(root)) {
        installed = path.dirname(path.join(root, candidate))
        break
      }
    }
    const source = `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`
    const record = refreshPlatforms
      ? {
          ...(installed ? await legal(installed) : await remoteLegal(name, version, source, locked[3])),
          integrity: locked[3],
          source,
        }
      : inventory[identity]
    if (
      !record ||
      record.name !== name ||
      record.version !== version ||
      record.integrity !== locked[3] ||
      record.source !== source ||
      !Array.isArray(record.texts) ||
      (!refreshPlatforms &&
        (!record.texts.length || record.texts.some((text) => typeof text !== "string" || !text.trim())))
    )
      throw new Error(
        `Missing or stale platform notices for ${identity}; install the locked platform package and run script/dependency-notices.ts --update-platform-notices`,
      )
    // The sharp-libvips repository's Apache license covers its packaging scripts,
    // while the published native libraries need their own publisher notice and LGPL/GPL terms.
    if (
      name.startsWith("@img/sharp-libvips-") &&
      ![
        "This software contains third-party libraries",
        "GNU LESSER GENERAL PUBLIC LICENSE",
        "GNU GENERAL PUBLIC LICENSE",
      ].every((notice) => record.texts.some((text) => text.includes(notice)))
    )
      throw new Error(
        `Incomplete bundled-library notices for ${identity}; preserve the verified publisher licensing notice and full LGPL/GPL terms, not the packaging scripts' Apache license`,
      )
    if (record.override) {
      if (
        !refreshPlatforms &&
        record.texts.join("\n\n") !== (await Bun.file(path.join(root, "licenses/dependencies", record.override)).text())
      )
        throw new Error(`Stale platform notice override for ${identity}; refresh the platform notices`)
      overrides.add(record.override)
    }
    platforms.set(identity, record)
    entries.push(record)
    await dependencies({ ...locked[2], name, version }, installed ?? from, [], true)
  }

  async function remoteLegal(name: string, version: string, source: string, integrity: string) {
    const response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Platform license source returned HTTP ${response.status}: ${name}@${version}`)
    const bytes = await response.arrayBuffer()
    if (`sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}` !== integrity)
      throw new Error(`Platform license source integrity mismatch: ${name}@${version}`)
    const files = await new Bun.Archive(bytes).files("package/*")
    const manifest = JSON.parse((await files.get("package/package.json")?.text()) ?? "null")
    if (manifest?.name !== name || manifest?.version !== version)
      throw new Error(`Platform license package identity mismatch: ${name}@${version}`)
    const temporary = await mkdtemp(path.join(os.tmpdir(), "vector-platform-notices-"))
    try {
      for (const [file, content] of files) {
        const basename = path.posix.basename(file)
        if (
          path.posix.dirname(file) !== "package" ||
          (basename !== "package.json" && !/^(licen[cs]e|copying|notice|copyright)([.\-_]|$)/i.test(basename))
        )
          continue
        await Bun.write(path.join(temporary, basename), content)
      }
      console.log(`Verified locked platform license source: ${name}@${version}`)
      return await legal(temporary)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  async function dependencies(
    pkg: {
      name: string
      version?: string
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    },
    dir: string,
    extra: string[] = [],
    platform = false,
  ) {
    const runtime = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...extra,
    ])
    for (const name of [...runtime].sort()) {
      const spec =
        lock.overrides?.[name] ??
        pkg.dependencies?.[name] ??
        pkg.optionalDependencies?.[name] ??
        pkg.devDependencies?.[name] ??
        "*"
      const alias = spec.startsWith("npm:") ? spec.slice(4).match(/^(.+)@([^@]+)$/) : undefined
      const identity = alias?.[1] ?? name
      const locked = platformLock(name, spec, pkg, !platform)
      if (locked) {
        await visitPlatform(locked, dir, refreshPlatforms ? await resolvePackage(name, dir) : undefined)
        continue
      }
      const next = await resolvePackage(name, dir, identity)
      if (!next) throw new Error(`Missing installed runtime dependency ${name} of ${pkg.name}`)
      const actual = await Bun.file(path.join(next, "package.json")).json()
      const range = alias?.[2] ?? (spec === "catalog:" ? lock.catalog?.[name] : spec)
      const records = lockedPackages.get(identity) ?? []
      const workspace = records.find((entry) => entry[0].startsWith(`${identity}@workspace:`))
      // Bun records Git commit prefixes, not the package's manifest version, for pinned Git sources.
      const git = range?.match(/^github:(.+)#([a-f0-9]{40})$/)
      const matches = workspace
        ? next === (await realpath(path.resolve(root, workspace[0].slice(`${identity}@workspace:`.length))))
        : git
          ? records.some((entry) => {
              const commit = entry[0].slice(`${identity}@github:${git[1]}#`.length)
              return (
                entry[0].startsWith(`${identity}@github:${git[1]}#`) &&
                /^[a-f0-9]{7,40}$/.test(commit) &&
                git[2].startsWith(commit)
              )
            })
          : !!range &&
            Bun.semver.satisfies(actual.version, range) &&
            records.some((entry) => entry[0] === `${actual.name}@${actual.version}`)
      if (actual.name !== identity || !matches)
        throw new Error(
          `Installed runtime dependency ${name}@${spec} of ${pkg.name} does not match its locked identity/version: found ${actual.name}@${actual.version} at ${next}`,
        )
      await visit(next)
    }
  }

  async function visit(dir: string) {
    if (visited.has(dir)) return
    visited.add(dir)
    const pkg = await Bun.file(path.join(dir, "package.json")).json()
    const workspace = workspaces.has(dir)
    if (!workspace) {
      const locked = platformLock(pkg.name, pkg.version)
      if (locked) return visitPlatform(locked, dir, refreshPlatforms ? dir : undefined)
      entries.push(await legal(dir))
      includeBundled(pkg)
    }
    const extra = new Set<string>()
    if (workspace) {
      // Include development-classified packages actually imported into runtime source.
      for await (const file of new Bun.Glob("src/**/*.{ts,tsx,js,jsx,mjs,css}").scan(dir)) {
        if (/\.(test|spec|stories)\./.test(file)) continue
        const source = await Bun.file(path.join(dir, file)).text()
        Object.keys(pkg.devDependencies ?? {})
          .filter((name) => source.includes(`"${name}`) || source.includes(`'${name}`))
          .forEach((name) => extra.add(name))
      }
      if (pkg.name === "vector-desktop") extra.add("electron")
    }
    await dependencies(pkg, dir, [...extra])
  }

  for (const name of ["engine", "app", "desktop", "tui", "ui"])
    await visit(await realpath(path.join(root, "packages", name)))
  const unused = (await readdir(path.join(root, "licenses/dependencies")).catch(() => [])).filter(
    (name) => name.endsWith(".txt") && !overrides.has(name),
  )
  if (unused.length) throw new Error(`Unused dependency notice overrides: ${unused.join(", ")}`)
  if (missing.length)
    throw new Error(
      `Missing license texts (add exact upstream notices under licenses/dependencies):\n${missing.join("\n")}`,
    )
  const unusedBundles = Object.keys(bundled).filter((identity) => !usedBundles.has(identity))
  if (unusedBundles.length) throw new Error(`Unused bundled provider notice records: ${unusedBundles.join(", ")}`)
  const stale = Object.keys(inventory).filter((identity) => !platforms.has(identity))
  if (!refreshPlatforms && stale.length) throw new Error(`Unused platform notice records: ${stale.join(", ")}`)
  if (refreshPlatforms)
    await Bun.write(
      inventoryFile,
      JSON.stringify(Object.fromEntries([...platforms].sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n",
    )
  const merged = new Map<string, Entry>()
  for (const entry of entries) {
    const identity = `${entry.name}@${entry.version}`
    const existing = merged.get(identity)
    if (existing && existing.license !== entry.license)
      throw new Error(`Conflicting license declarations for ${identity}`)
    merged.set(identity, { ...entry, texts: [...new Set([...(existing?.texts ?? []), ...entry.texts])] })
  }
  const unique = [...merged.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
  return {
    count: unique.length,
    body: [
      "# Vector bundled dependency notices",
      "Generated from Vector's runtime dependency closure, locked platform-package license sources, and integrity-pinned inventories of code embedded in provider SDKs. Includes bundled JavaScript and external native packages for every locked platform, independent of the build host. Vector's own notices, vendored assets and runtimes are covered in THIRD_PARTY_NOTICES.md. Individual component licenses remain authoritative.",
      ...unique.map(
        (entry) =>
          `## ${entry.name}@${entry.version}\n\nLicense: ${entry.license}\n\n${entry.texts.map((text) => text.replaceAll("\r\n", "\n").replace(/[ \t]+$/gm, "")).join("\n\n")}`,
      ),
      "",
    ].join("\n\n"),
  }
}

function ancestors(from: string): string[] {
  const parent = path.dirname(from)
  return parent === from ? [from] : [from, ...ancestors(parent)]
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..")
  const result = await dependencyNotices(root, process.argv.includes("--update-platform-notices"))
  await Bun.write(
    process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? path.join(root, "DEPENDENCY_NOTICES.md"),
    result.body,
  )
  console.log(`Generated notices for ${result.count} packages`)
}
