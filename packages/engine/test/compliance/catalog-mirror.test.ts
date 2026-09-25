import { expect, test } from "bun:test"
import { catalogBody } from "../../script/release-catalog"
import { verifyCatalogMirror } from "../../script/verify-catalog-mirror"

const text = catalogBody(JSON.stringify({ openai: { id: "openai", name: "OpenAI", env: [], models: {} } }))

for (const kind of ["valid", "missing", "html", "changed", "stale"] as const) {
  test(`public mirror smoke test validates both aliases and the release bytes: ${kind}`, async () => {
    const requests: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname
        requests.push(pathname)
        return new Response(kind === "changed" && pathname.endsWith("api.json") ? `${text}\n` : text, {
          status: kind === "missing" ? 404 : 200,
          headers: { "content-type": kind === "html" ? "text/html" : "application/json" },
        })
      },
    })
    try {
      const result = verifyCatalogMirror(
        (url, init) => fetch(new URL(new URL(String(url)).pathname, server.url), init),
        kind === "stale" ? "different snapshot" : text,
      )
      if (kind === "valid") expect(await result).toEqual({ urls: 2, providers: 1 })
      if (kind !== "valid")
        await expect(result).rejects.toThrow(
          kind === "missing"
            ? "HTTP 404"
            : kind === "html"
              ? "application/json"
              : kind === "changed"
                ? "canonical"
                : "reviewed release snapshot",
        )
      expect(requests.sort()).toEqual(["/models", "/models/api.json"])
    } finally {
      await server.stop(true)
    }
  })
}
