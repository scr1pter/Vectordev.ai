export * from "./gen/types.gen.js"
export type { FileSystemEntry as LocationFileSystemEntry } from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { VectorClient } from "./gen/sdk.gen.js"
import { wrapClientError } from "../error-interceptor.js"
import { requestWithURL } from "../request.js"
export { type Config as VectorClientConfig, VectorClient }

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (fallback && (value === fallback || (encode && value === encode(fallback)))) return fallback
  if (!encode) return value
  try {
    return decodeURIComponent(value)
  } catch {
    // A literal percent sign or malformed UTF-8 escape can be part of a path.
    // Preserve the original header instead of failing request construction.
    return value
  }
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-vector-directory", "directory"],
    ["x-vector-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    for (const query of url.pathname.startsWith("/api/") ? [key, `location[${key}]`] : [key]) {
      if (!url.searchParams.has(query)) {
        url.searchParams.set(query, value)
      }
    }
    changed = true
  }

  if (!changed) return request

  return requestWithURL(request, url)
}

export function createVectorClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
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

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-vector-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of Vector Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new VectorClient({ client })
}
