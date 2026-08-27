// Asserts a packaged desktop app can actually check for updates.
//
// 1.19.96 shipped without Contents/Resources/app-update.yml and every update
// check died with `ENOENT ... app-update.yml`, which the UI reported only as
// "Updates unavailable". electron-builder writes that file when it produces a
// real artifact; a `--dir` build skips it, so a packaged-looking app can be
// missing the one file the updater needs and nothing says so until a user
// clicks the button.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type PackageCheck = { ok: true } | { ok: false; problem: string }

export function checkUpdaterMetadata(input: { present: boolean; contents?: string }): PackageCheck {
  if (!input.present) {
    return {
      ok: false,
      problem:
        "app-update.yml is missing. electron-builder only writes it for a real target, so this was probably packaged with --dir. Every update check will fail with ENOENT.",
    }
  }
  const contents = input.contents ?? ""
  if (!/^provider:\s*\S+/m.test(contents)) return { ok: false, problem: "app-update.yml has no provider." }
  if (!/^url:\s*https:\/\/\S+/m.test(contents)) {
    return { ok: false, problem: "app-update.yml has no https update feed url." }
  }
  return { ok: true }
}

export function updaterMetadataPath(appPath: string) {
  return join(appPath, "Contents", "Resources", "app-update.yml")
}

// Given no argument, check every .app the last package run produced. The arch
// suffix on the output directory varies (mac, mac-arm64, mac-x64), so a fixed
// path would quietly verify nothing on the arch it was not written for.
export function packagedApps(distEntries: readonly { dir: string; apps: readonly string[] }[]) {
  return distEntries.flatMap((entry) => entry.apps.map((app) => join(entry.dir, app)))
}

if (import.meta.main) {
  const explicit = process.argv[2]
  const targets: string[] = []
  if (explicit) targets.push(explicit)
  else {
    const dist = join(import.meta.dir, "..", "dist")
    for (const dir of readdirSync(dist, { withFileTypes: true })) {
      if (!dir.isDirectory() || !dir.name.startsWith("mac")) continue
      const full = join(dist, dir.name)
      for (const entry of readdirSync(full)) if (entry.endsWith(".app")) targets.push(join(full, entry))
    }
  }
  if (!targets.length) {
    console.error("no packaged macOS app found to verify")
    process.exit(2)
  }
  for (const appPath of targets) verify(appPath)
  process.exit(0)
}

function verify(appPath: string) {
  const file = updaterMetadataPath(appPath)
  const present = existsSync(file)
  const result = checkUpdaterMetadata({
    present,
    contents: present ? readFileSync(file, "utf8") : undefined,
  })
  if (!result.ok) {
    console.error(`${appPath} cannot self-update: ${result.problem}`)
    process.exit(1)
  }
  console.log(`verified ${appPath} can reach its update feed`)
}
