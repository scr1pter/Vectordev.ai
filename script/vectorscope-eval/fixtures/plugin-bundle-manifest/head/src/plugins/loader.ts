import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { logger } from "../logger"
import { InvalidBundleError, readManifest, type PluginManifest } from "./manifest"

export interface LoadedPlugin {
  name: string
  path: string
  manifest: PluginManifest
}

// Runs when a workspace opens and on every change the plugin directory watcher reports.
export async function discoverPlugins(dir: string): Promise<LoadedPlugin[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const bundles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".vplg"))
  const loaded = await Promise.all(bundles.map((entry) => load(join(dir, entry.name))))
  return loaded.filter((plugin): plugin is LoadedPlugin => plugin !== undefined)
}

// A bundle that is still being copied in, or is not a bundle at all, is skipped until the next change.
async function load(path: string): Promise<LoadedPlugin | undefined> {
  const manifest = await readManifest(path).catch((error: unknown) => {
    if (!(error instanceof InvalidBundleError)) throw error
    logger.warn("skipping plugin bundle", { path, reason: error.message })
    return undefined
  })
  if (!manifest) return undefined
  return { name: manifest.name, path, manifest }
}
