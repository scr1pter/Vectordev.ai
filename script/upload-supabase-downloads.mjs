import { createReadStream, statSync } from "node:fs"
import { basename, join } from "node:path"

const supabaseUrl = process.env.SUPABASE_URL || "https://junpwyqhgawhfrnjoeyy.supabase.co"
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const bucket = process.env.SUPABASE_DOWNLOAD_BUCKET || "vector-downloads"
const distDir = new URL("../packages/desktop/dist/", import.meta.url)

const files = [
  {
    local: "vector-desktop-mac-arm64.dmg",
    remote: "vector-desktop-mac-arm64.dmg",
    contentType: "application/x-apple-diskimage",
  },
  {
    local: "vector-desktop-mac-x64.dmg",
    remote: "vector-desktop-mac-x64.dmg",
    contentType: "application/x-apple-diskimage",
  },
  {
    local: "vector-desktop-win-x64.exe",
    remote: "vector-desktop-win-x64.exe",
    contentType: "application/vnd.microsoft.portable-executable",
  },
  {
    local: "vector-desktop-win-arm64.exe",
    remote: "vector-desktop-win-arm64.exe",
    contentType: "application/vnd.microsoft.portable-executable",
  },
  {
    local: "vector-desktop-linux-x86_64.AppImage",
    remote: "vector-desktop-linux-x86_64.AppImage",
    contentType: "application/octet-stream",
  },
  {
    local: "vector-desktop-linux-arm64.AppImage",
    remote: "vector-desktop-linux-arm64.AppImage",
    contentType: "application/octet-stream",
  },
  {
    local: "checksums.txt",
    remote: "checksums.txt",
    contentType: "text/plain; charset=utf-8",
  },
]

if (!serviceKey) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY.")
  console.error("Set it locally before running this script. Do not commit it.")
  process.exit(1)
}

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
}

async function createBucket() {
  const response = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: bucket,
      name: bucket,
      public: true,
      file_size_limit: 350 * 1024 * 1024,
      allowed_mime_types: null,
    }),
  })

  if (response.ok) return

  const text = await response.text()
  if (response.status === 409 || text.includes("already exists")) return
  throw new Error(`Could not create bucket: ${response.status} ${text}`)
}

async function uploadFile(file) {
  const localPath = join(distDir.pathname, file.local)
  const size = statSync(localPath).size
  const response = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${file.remote}`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": file.contentType,
      "Content-Length": String(size),
      "x-upsert": "true",
    },
    body: createReadStream(localPath),
    duplex: "half",
  })

  if (!response.ok) {
    throw new Error(`Could not upload ${basename(localPath)}: ${response.status} ${await response.text()}`)
  }

  console.log(`${file.remote}`)
  console.log(`${supabaseUrl}/storage/v1/object/public/${bucket}/${file.remote}`)
}

await createBucket()

for (const file of files) {
  await uploadFile(file)
}
