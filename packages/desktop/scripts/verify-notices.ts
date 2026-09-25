import { stat } from "node:fs/promises"
import path from "node:path"

export async function verifyNotices(directory: string, platform: "darwin" | "win32" | "linux") {
  const resources =
    platform === "darwin" ? path.join(directory, "Contents/Resources") : path.join(directory, "resources")
  const files = [
    ...["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"].map((file) => path.join(resources, file)),
    ...(platform === "darwin"
      ? ["Electron-LICENSE.txt", "LICENSES.chromium.html"].map((file) => path.join(resources, file))
      : ["LICENSE", "LICENSES.chromium.html"].map((file) => path.join(directory, file))),
  ]
  for (const file of files) {
    const info = await stat(file).catch(() => undefined)
    if (!info?.isFile() || info.size === 0) throw new Error(`Packaged license notice is missing or empty: ${file}`)
  }
}

if (import.meta.main) {
  const platform = process.argv[2]
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux")
    throw new Error("Specify a supported package platform")
  if (process.argv.length < 4) throw new Error("Specify each unpacked application directory")
  for (const directory of process.argv.slice(3)) {
    await verifyNotices(directory, platform)
    console.log(`Verified bundled license notices: ${directory}`)
  }
}
