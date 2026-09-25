import { catalogBody } from "./release-catalog"

export async function verifyCatalogMirror(
  request: (input: string, init: RequestInit) => Promise<Response> = fetch,
  expected?: string,
) {
  const bodies = await Promise.all(
    ["https://vectordev.ai/models", "https://vectordev.ai/models/api.json"].map(async (url) => {
      const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(30_000) })
      if (response.status !== 200)
        throw new Error(`${url} returned HTTP ${response.status}; publish the Vector catalog mirror before release`)
      if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? ""))
        throw new Error(`${url} must serve application/json`)
      const text = await response.text()
      if (catalogBody(text) !== text) throw new Error(`${url} is not a canonical reviewed Vector catalog`)
      if (expected !== undefined && text !== expected)
        throw new Error(`${url} does not match the reviewed release snapshot`)
      return text
    }),
  )
  if (bodies[0] !== bodies[1]) throw new Error("The Vector catalog mirror aliases returned different snapshots")
  return { urls: 2, providers: Object.keys(JSON.parse(bodies[0])).length }
}

if (import.meta.main) {
  const file = process.env.VECTOR_RELEASE_CATALOG_PATH
  console.log(JSON.stringify(await verifyCatalogMirror(fetch, file ? await Bun.file(file).text() : undefined)))
}
