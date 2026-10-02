import { resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

// Exercise the same pruned static output and public-share rewrite used in production.
const root = fileURLToPath(new URL("../../../web/dist/", import.meta.url))
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PLAYWRIGHT_VIEWER_PORT),
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    const route = /^\/s\/[a-f0-9]{32}$/.test(pathname) ? "/s/index.html" : pathname
    const path = resolve(root, `.${route.endsWith("/") ? `${route}index.html` : route}`)
    if (!path.startsWith(`${resolve(root)}${sep}`)) return new Response(null, { status: 404 })
    const file = Bun.file(path)
    if (!(await file.exists())) return new Response(null, { status: 404 })
    return new Response(file, { headers: { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } })
  },
})
console.log(`Public viewer test server: ${server.url}`)
