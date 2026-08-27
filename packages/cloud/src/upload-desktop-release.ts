import path from "node:path"
import { copy, put } from "@vercel/blob"
import { desktopReleaseVersion } from "./desktop-release-version"

const version = desktopReleaseVersion(process.env.VECTOR_RELEASE_VERSION)
const channel = process.env.VECTOR_RELEASE_CHANNEL === "beta" ? "beta" : "latest"
const source = path.resolve(process.env.VECTOR_RELEASE_DIR ?? path.join(import.meta.dir, "../../desktop/dist"))
const dryRun = process.env.VECTOR_RELEASE_DRY_RUN === "true"
const uploadOptions = {
  access: "public",
  addRandomSuffix: false,
  allowOverwrite: true,
} as const
const putOptions = {
  ...uploadOptions,
  multipart: true,
} as const

if (!dryRun && !process.env.BLOB_READ_WRITE_TOKEN) {
  throw new Error("BLOB_READ_WRITE_TOKEN is required")
}

const asset = (name: string) => `vector-desktop-${version}-${name}`
const downloads = new Map([
  [asset("mac-arm64.dmg"), "vector-desktop-mac-arm64.dmg"],
  [asset("mac-x64.dmg"), "vector-desktop-mac-x64.dmg"],
  [asset("win-x64.exe"), "vector-desktop-win-x64.exe"],
  [asset("win-arm64.exe"), "vector-desktop-win-arm64.exe"],
  [asset("linux-x86_64.AppImage"), "vector-desktop-linux-x86_64.AppImage"],
  [asset("linux-arm64.AppImage"), "vector-desktop-linux-arm64.AppImage"],
  ["checksums.txt", "checksums.txt"],
])
const updateAssets = [
  asset("mac-arm64.dmg"),
  asset("mac-arm64.dmg.blockmap"),
  asset("mac-arm64.zip"),
  asset("mac-arm64.zip.blockmap"),
  asset("mac-x64.dmg"),
  asset("mac-x64.dmg.blockmap"),
  asset("mac-x64.zip"),
  asset("mac-x64.zip.blockmap"),
  asset("win-x64.exe"),
  asset("win-x64.exe.blockmap"),
  asset("win-arm64.exe"),
  asset("win-arm64.exe.blockmap"),
  asset("linux-x86_64.AppImage"),
  asset("linux-arm64.AppImage"),
]
const updateMetadata = ["latest-mac.yml", "latest.yml", "latest-linux.yml", "latest-linux-arm64.yml"]
const updatePrefix = channel === "beta" ? "releases/vector-beta-updates" : "releases/vector-updates"

for (const name of new Set([...downloads.keys(), ...updateAssets, ...updateMetadata])) {
  if (!(await Bun.file(path.join(source, name)).exists())) {
    throw new Error(`Missing desktop release asset: ${name}`)
  }
}

async function publish(name: string, pathnames: string[]) {
  const primaryPathname = pathnames[0]
  if (!primaryPathname) throw new Error(`No desktop release destination for: ${name}`)

  if (dryRun) {
    pathnames.forEach((pathname) => console.log(`validated ${pathname}`))
    return primaryPathname
  }

  const result = await put(primaryPathname, Bun.file(path.join(source, name)), putOptions)
  console.log(`uploaded ${primaryPathname}`)
  await Promise.all(
    pathnames.slice(1).map(async (pathname) => {
      await copy(result.url, pathname, uploadOptions)
      console.log(`copied ${pathname}`)
    }),
  )
  return result.url
}

const immutableUrls = new Map<string, string>()
for (const name of new Set([...updateAssets, ...downloads.keys()])) {
  const downloadName = downloads.get(name)
  const pathnames = [
    ...(updateAssets.includes(name) ? [`${updatePrefix}/${name}`] : []),
    ...(downloadName ? [`releases/vector-v${version}/${downloadName}`] : []),
  ]
  immutableUrls.set(name, await publish(name, pathnames))
}

// Stable direct-download aliases are independent mutable objects, so they cannot
// change as one atomic set. Update them only after every version-specific object exists.
if (channel === "latest") {
  for (const [name, downloadName] of downloads) {
    const pathname = `releases/vector-downloads/${downloadName}`
    if (dryRun) {
      console.log(`validated ${pathname}`)
      continue
    }

    const url = immutableUrls.get(name)
    if (!url) throw new Error(`Missing uploaded desktop release URL: ${name}`)
    await copy(url, pathname, uploadOptions)
    console.log(`copied ${pathname}`)
  }
}

// These small mutable pointers are the updater commit step. Every artifact they
// reference and every direct-download alias has completed before clients discover it.
for (const name of updateMetadata) {
  await publish(name, [`${updatePrefix}/${name}`])
}
