import { copyFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "packages", "web", "dist")

const keep = new Set([
  "_astro",
  "index.html",
  "404.html",
  "favicon.ico",
  "favicon.svg",
  "favicon-v3.ico",
  "favicon-v3.svg",
  "favicon-96x96.png",
  "favicon-96x96-v3.png",
  "apple-touch-icon.png",
  "apple-touch-icon-v3.png",
  "site.webmanifest",
  "web-app-manifest-192x192.png",
  "web-app-manifest-512x512.png",
  "robots.txt",
])

for (const entry of await readdir(dist)) {
  if (keep.has(entry)) continue
  await rm(path.join(dist, entry), { recursive: true, force: true })
}

await copyFile(path.join(dist, "index.html"), path.join(dist, "404.html"))
