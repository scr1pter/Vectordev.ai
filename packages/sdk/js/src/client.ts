export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { VectorClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "./error-interceptor.js"
export { type Config as VectorClientConfig, VectorClient }

function pick(value: string | null, fallback?: string) {
  if (!value) return
  if (fallback && (value === fallback || value === encodeURIComponent(fallback))) return fallback
  try {
    return decodeURIComponent(value)
  } catch {
    // A literal percent sign or malformed UTF-8 escape can be part of a path.
    // Preserve the original header instead of failing request construction.
    return value
  }
}

function rewrite(request: Request, directory?: string) {
  const url = new URL(request.url)
  for (const [header, query] of [
    ["x-vector-directory", "directory"],
    ["x-vector-workspace", "workspace"],
  ] as const) {
    const raw = request.headers.get(header)
    const value = query === "directory" ? pick(raw, directory) : raw
    if (value && !url.searchParams.has(query)) url.searchParams.set(query, value)
  }
  return new Request(url, request)
}

export function createVectorClient(config?: Config & { directory?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-vector-directory": encodeURIComponent(config.directory),
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) => rewrite(request, config?.directory))
  client.interceptors.error.use(wrapClientError)
  return new VectorClient({ client })
}
