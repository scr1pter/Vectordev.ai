import type { APIRoute } from "astro"

const files: Record<string, string> = {
  mac: "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/vector-desktop-mac-arm64.dmg",
  "mac-arm64":
    "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/vector-desktop-mac-arm64.dmg",
  "mac-x64":
    "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/vector-desktop-mac-x64.dmg",
  windows:
    "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/vector-desktop-win-x64.exe",
  "windows-x64":
    "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/vector-desktop-win-x64.exe",
  "windows-arm64":
    "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/vector-desktop-win-arm64.exe",
  linux:
    "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/vector-desktop-linux-x86_64.AppImage",
  "linux-x64":
    "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/vector-desktop-linux-x86_64.AppImage",
  "linux-arm64":
    "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/vector-desktop-linux-arm64.AppImage",
  checksums: "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/checksums.txt",
}

export const GET: APIRoute = ({ params }) => {
  const file = files[params.target || ""]
  if (!file) {
    return new Response("Download not found", { status: 404 })
  }

  return Response.redirect(file, 302)
}
