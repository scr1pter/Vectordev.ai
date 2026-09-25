export * as ConfigManaged from "./managed"

import { existsSync } from "fs"
import os from "os"
import path from "path"
import { Process } from "@/util/process"

const MANAGED_PLIST_DOMAINS = ["ai.vector.managed"]

// Keys injected by macOS/MDM into the managed plist that are not Vector config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

function systemManagedConfigDir(name = "vector"): string {
  switch (process.platform) {
    case "darwin":
      return `/Library/Application Support/${name}`
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", name)
    default:
      return `/etc/${name}`
  }
}

export function managedConfigDir() {
  const override = process.env.VECTOR_TEST_MANAGED_CONFIG_DIR
  if (override) return override
  return systemManagedConfigDir()
}

export function parseManagedPlist(json: string): string {
  const raw = JSON.parse(json)
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

export async function readManagedPreferences() {
  if (process.platform !== "darwin") return

  const user = (() => {
    try {
      return os.userInfo().username || "user"
    } catch {
      return "user"
    }
  })()
  const paths = MANAGED_PLIST_DOMAINS.flatMap((domain) => [
    path.join("/Library/Managed Preferences", user, `${domain}.plist`),
    path.join("/Library/Managed Preferences", `${domain}.plist`),
  ])

  for (const plist of paths) {
    if (!existsSync(plist)) continue
    const result = await Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true })
    if (result.code !== 0) continue
    return {
      source: `mobileconfig:${plist}`,
      text: parseManagedPlist(result.stdout.toString()),
    }
  }

  return
}
