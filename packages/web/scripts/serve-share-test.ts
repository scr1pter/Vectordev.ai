import path from "node:path"

// Serve only a built, pruned site. Mirror the literal production /s rewrite.
const root = path.resolve(import.meta.dir, "../dist")
const config = await Bun.file(new URL("../../../vercel.json", import.meta.url)).json()
if (
  !config.rewrites.some(
    (entry: { source: string; destination: string }) =>
      entry.source === "/s/:id([a-f0-9]{32})" && entry.destination === "/s/index.html",
  )
)
  throw new Error("Public viewer rewrite is missing")
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PLAYWRIGHT_PORT ?? 45692),
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    const route = /^\/s\/[a-f0-9]{32}\/?$/.test(pathname) ? "/s/index.html" : pathname
    const resolved = path.resolve(root, `.${route === "/" ? "/index.html" : route}`)
    if (!resolved.startsWith(`${root}/`)) return new Response(null, { status: 404 })
    const file = Bun.file(resolved)
    if (!(await file.exists())) return new Response(null, { status: 404 })
    return new Response(file, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } })
  },
})
