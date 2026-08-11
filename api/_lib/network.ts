import { lookup } from "node:dns/promises"
import { request as requestHttp, type IncomingMessage, type RequestOptions } from "node:http"
import { request as requestHttps } from "node:https"
import { BlockList, isIP } from "node:net"
import { ApiError } from "./http.js"

const blockedIpv4 = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(network, prefix, "ipv4")
}
blockedIpv4.addAddress("168.63.129.16", "ipv4")

const globalIpv6 = new BlockList()
globalIpv6.addSubnet("2000::", 3, "ipv6")

const blockedIpv6 = new BlockList()
for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6.addSubnet(network, prefix, "ipv6")
}

const blockedHostnames = new Set([
  "instance-data",
  "instance-data.ec2.internal",
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
])
const blockedHostnameSuffixes = [".home.arpa", ".internal", ".invalid", ".local", ".localhost", ".test"]

export type PublicTarget = {
  url: URL
  address: string
  family: 4 | 6
  hostname: string
}

export type PinnedRequestOptions = {
  method: string
  headers: Record<string, string>
  body?: string
  signal: AbortSignal
}

function hostnameWithoutBrackets(hostname: string) {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "")
  return blockedHostnames.has(normalized) || blockedHostnameSuffixes.some((suffix) => normalized.endsWith(suffix))
}

export function isPublicIp(address: string) {
  const normalized = hostnameWithoutBrackets(address.trim())
  const family = isIP(normalized)
  if (family === 4) return !blockedIpv4.check(normalized, "ipv4")
  if (family === 6) {
    return globalIpv6.check(normalized, "ipv6") && !blockedIpv6.check(normalized, "ipv6")
  }
  return false
}

export async function resolvePublicUrl(raw: string): Promise<PublicTarget> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ApiError(400, "URL_INVALID", "Enter a valid HTTP or HTTPS URL.")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ApiError(400, "URL_INVALID", "Vector Play Park supports HTTP and HTTPS APIs.")
  }
  if (url.username || url.password) {
    throw new ApiError(400, "URL_CREDENTIALS_BLOCKED", "Put credentials in request headers, not in the URL.")
  }
  if (url.port === "0") {
    throw new ApiError(400, "URL_INVALID", "Enter a URL with a valid network port.")
  }

  url.hash = ""
  const hostname = hostnameWithoutBrackets(url.hostname).toLowerCase().replace(/\.$/, "")
  if (!hostname || isBlockedHostname(hostname)) {
    throw new ApiError(
      400,
      "PRIVATE_URL_BLOCKED",
      "Cloud API requests cannot access local, metadata, or private networks.",
    )
  }

  const literalFamily = isIP(hostname)
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new ApiError(400, "URL_UNRESOLVED", "Vector could not resolve that API hostname.")
  }

  if (!addresses.length) {
    throw new ApiError(400, "URL_UNRESOLVED", "Vector could not resolve that API hostname.")
  }
  if (addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new ApiError(
      400,
      "PRIVATE_URL_BLOCKED",
      "Cloud API requests cannot access local, metadata, or private networks.",
    )
  }

  const selected = addresses[0]!
  const family = isIP(selected.address)
  if (family !== 4 && family !== 6) {
    throw new ApiError(400, "URL_UNRESOLVED", "Vector could not resolve that API hostname.")
  }
  return { url, address: selected.address, family, hostname }
}

export function requestPinnedUrl(target: PublicTarget, options: PinnedRequestOptions): Promise<IncomingMessage> {
  const requestOptions: RequestOptions = {
    protocol: target.url.protocol,
    hostname: target.address,
    family: target.family,
    port: target.url.port ? Number(target.url.port) : undefined,
    path: `${target.url.pathname}${target.url.search}`,
    method: options.method,
    headers: { ...options.headers, host: target.url.host },
    signal: options.signal,
    agent: false,
  }

  return new Promise((resolve, reject) => {
    const onResponse = (response: IncomingMessage) => resolve(response)
    const request =
      target.url.protocol === "https:"
        ? requestHttps(
            {
              ...requestOptions,
              servername: isIP(target.hostname) ? undefined : target.hostname,
              rejectUnauthorized: true,
            },
            onResponse,
          )
        : requestHttp(requestOptions, onResponse)

    request.once("error", reject)
    request.end(options.body)
  })
}
