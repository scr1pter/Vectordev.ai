export function nativeWindowChromeLayout(input: {
  enabled: boolean
  platform: "web" | "desktop"
  os?: "macos" | "windows" | "linux"
  zoom?: number
}) {
  if (!input.enabled || input.platform !== "desktop" || (input.os !== "macos" && input.os !== "windows")) return
  const zoom = Math.max(
    typeof input.zoom === "number" && Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1,
    0.25,
  )
  return {
    os: input.os,
    height: input.os === "macos" ? 40 / zoom : 40 / Math.min(zoom, 1),
    left: input.os === "macos" ? 84 / zoom : 0,
    right: input.os === "windows" ? 138 / zoom : 0,
  }
}
