import { SecurityConfigurationError } from "@vectordevai/core/flag/security"
import { isIP } from "node:net"
import { ServerAuth } from "./auth"

export function assertListenSecurity(opts: { hostname: string; unsecured?: boolean }, config: ServerAuth.Info) {
  if (ServerAuth.required(config) || opts.unsecured === true || isLoopback(opts.hostname)) return
  throw new SecurityConfigurationError(
    `Refusing to listen on ${opts.hostname} without authentication. Set VECTOR_SERVER_PASSWORD or explicitly pass --unsecured.`,
  )
}

function isLoopback(hostname: string) {
  const address = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (address === "localhost") return true
  if (isIP(address) === 4) return address.startsWith("127.")
  if (isIP(address) !== 6) return false
  const normalized = new URL(`http://[${address}]`).hostname
  return normalized === "[::1]" || /^\[::ffff:7f[\da-f]{2}:[\da-f]{1,4}\]$/.test(normalized)
}
