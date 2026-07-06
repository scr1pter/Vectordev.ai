import type { APIRoute } from "astro"

const baseUrl = import.meta.env.PUBLIC_DOWNLOAD_BASE_URL || "https://junpwyqhgawhfrnjoeyy.supabase.co/storage/v1/object/public/vector-downloads"

const files: Record<string, string> = {
  "mac-arm64": "vector-desktop-mac-arm64.dmg",
  "mac-x64": "vector-desktop-mac-x64.dmg",
  windows: "vector-desktop-win-x64.exe",
  linux: "vector-desktop-linux-x86_64.AppImage",
}

export const GET: APIRoute = ({ params }) => {
  const file = files[params.target || ""]
  if (!file) {
    return new Response("Download not found", { status: 404 })
  }

  return Response.redirect(`${baseUrl}/${file}`, 302)
}
