import { createVectorClient } from "@vectordevai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"
import { insecurePasswordReason } from "@/context/server"

export function basicAuthTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "vector"}:${input.password}`)
}

export function consumeInviteCredentials(
  location: Pick<Location, "hash" | "pathname" | "search">,
  replace: (url: string) => void,
) {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""))
  if (!params.has("auth_token")) return
  const token = params.get("auth_token")
  params.delete("auth_token")
  replace(`${location.pathname}${location.search}${params.size ? `#${params}` : ""}`)
  if (!token) return

  try {
    const decoded = atob(token)
    const separator = decoded.indexOf(":")
    if (separator === -1) return
    return {
      username: decoded.slice(0, separator) || "vector",
      password: decoded.slice(separator + 1),
    }
  } catch {
    return
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createVectorClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const insecure = insecurePasswordReason(server)
  if (insecure) throw new Error(insecure)
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${basicAuthTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createVectorClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}
