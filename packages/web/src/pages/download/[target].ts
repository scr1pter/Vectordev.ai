import type { APIRoute } from "astro"

const aliases: Record<string, string> = {
  mac: "mac-arm64",
  "mac-arm64": "mac-arm64",
  "mac-x64": "mac-x64",
  windows: "windows-x64",
  "windows-x64": "windows-x64",
  "windows-arm64": "windows-arm64",
  linux: "linux-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
}

export const GET: APIRoute = ({ params, site }) => {
  if (params.target === "checksums") {
    return Response.redirect(
      "https://42qryducihx01gl0.public.blob.vercel-storage.com/releases/vector-downloads/checksums.txt",
      302,
    )
  }
  const target = aliases[params.target || ""]
  if (!target) return new Response("Download not found", { status: 404 })
  return Response.redirect(new URL(`/download?target=${encodeURIComponent(target)}`, site ?? "https://vectordev.ai"), 302)
}
