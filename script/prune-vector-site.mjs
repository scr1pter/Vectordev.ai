import { copyFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(root, "packages", "web", "dist")

const keep = new Set([
  "about",
  "_astro",
  "account",
  "auth",
  "docs",
  "download",
  "legal",
  "license",
  "login",
  "releases",
  "index.html",
  "404.html",
  "favicon.ico",
  "favicon.svg",
  "favicon-v3.ico",
  "favicon-v3.svg",
  "favicon-96x96.png",
  "favicon-96x96-v3.png",
  "favicon-32x32-desktop-v4.png",
  "favicon-96x96-desktop-v4.png",
  "favicon-desktop-v4.ico",
  "apple-touch-icon.png",
  "apple-touch-icon-v3.png",
  "apple-touch-icon-desktop-v4.png",
  "site.webmanifest",
  "web-app-manifest-192x192.png",
  "web-app-manifest-512x512.png",
  "robots.txt",
  "sitemap-0.xml",
  "sitemap-index.xml",
  "theme.json",
  // The feed the desktop app polls for "what's new". Pruning it is what made
  // the release-notes dialog silently never run.
  "changelog.json",
  "vector-logo.png",
  "vector-space-backdrop.png",
])

for (const entry of await readdir(dist)) {
  if (keep.has(entry)) continue
  await rm(path.join(dist, entry), { recursive: true, force: true })
}

await copyFile(path.join(dist, "index.html"), path.join(dist, "404.html"))
