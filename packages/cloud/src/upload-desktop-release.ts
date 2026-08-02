import path from "node:path"
import { copy, put } from "@vercel/blob"

const version = process.env.VECTOR_RELEASE_VERSION?.replace(/^v/, "")
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

if (!version) throw new Error("VECTOR_RELEASE_VERSION is required")
if (!dryRun && !process.env.BLOB_READ_WRITE_TOKEN) {
  throw new Error("BLOB_READ_WRITE_TOKEN is required")
}

const downloads = [
  "vector-desktop-mac-arm64.dmg",
  "vector-desktop-mac-x64.dmg",
  "vector-desktop-win-x64.exe",
  "vector-desktop-win-arm64.exe",
  "vector-desktop-linux-x86_64.AppImage",
  "vector-desktop-linux-arm64.AppImage",
  "checksums.txt",
]

const updates = [
  "latest-mac.yml",
  "latest.yml",
  "latest-linux.yml",
  "latest-linux-arm64.yml",
  "vector-desktop-mac-arm64.dmg",
  "vector-desktop-mac-arm64.dmg.blockmap",
  "vector-desktop-mac-arm64.zip",
  "vector-desktop-mac-arm64.zip.blockmap",
  "vector-desktop-mac-x64.dmg",
  "vector-desktop-mac-x64.dmg.blockmap",
  "vector-desktop-mac-x64.zip",
  "vector-desktop-mac-x64.zip.blockmap",
  "vector-desktop-win.exe",
  "vector-desktop-win.exe.blockmap",
  "vector-desktop-win-x64.exe",
  "vector-desktop-win-x64.exe.blockmap",
  "vector-desktop-win-arm64.exe",
  "vector-desktop-win-arm64.exe.blockmap",
  "vector-desktop-linux-x86_64.AppImage",
  "vector-desktop-linux-arm64.AppImage",
]

for (const name of new Set([...downloads, ...updates])) {
  if (!(await Bun.file(path.join(source, name)).exists())) {
    throw new Error(`Missing desktop release asset: ${name}`)
  }
}

for (const name of new Set([...downloads, ...updates])) {
  const prefixes = [
    ...(downloads.includes(name) ? [`releases/vector-v${version}`] : []),
    ...(downloads.includes(name) && channel === "latest" ? ["releases/vector-downloads"] : []),
    ...(updates.includes(name)
      ? [channel === "beta" ? "releases/vector-beta-updates" : "releases/vector-updates"]
      : []),
  ]
  const pathnames = prefixes.map((prefix) => `${prefix}/${name}`)

  if (dryRun) {
    pathnames.forEach((pathname) => console.log(`validated ${pathname}`))
    continue
  }

  const result = await put(pathnames[0], Bun.file(path.join(source, name)), putOptions)
  console.log(`uploaded ${pathnames[0]}`)
  await Promise.all(
    pathnames.slice(1).map(async (pathname) => {
      await copy(result.url, pathname, uploadOptions)
      console.log(`copied ${pathname}`)
    }),
  )
}
