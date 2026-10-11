import { connect } from "node:tls"

import { normalizeCloudDomain } from "./cloud-console"
import {
  arrayField,
  booleanField,
  numberField,
  stringField,
  vercelLinkContext,
  vercelPages,
  vercelRequest,
  VercelError,
  type VercelFetch,
  type VercelLinkContext,
} from "./cloud-vercel-api"

// Custom domains on the linked Vercel project, with the exact DNS records
// Vercel recommends for each and the state of its TLS certificate.

export type VercelDnsRecord = {
  type: "A" | "CNAME" | "TXT"
  name: string
  value: string
  purpose: "routing" | "verification"
}

export type VercelCertificate =
  | { status: "issued"; expiresAt: string; issuer?: string }
  | { status: "pending"; detail: string }

export type VercelDomain = {
  name: string
  apex: boolean
  /** Vercel confirmed the project may use the domain. */
  verified: boolean
  /** DNS points at Vercel and a certificate can be issued. */
  configured: boolean
  status: "ready" | "needs_verification" | "needs_dns"
  records: VercelDnsRecord[]
  certificate?: VercelCertificate
  redirect?: string
  gitBranch?: string
  detail: string
}

export type CertificateCheck = (domain: string) => Promise<VercelCertificate>

type DomainOptions = { request?: VercelFetch; certificate?: CertificateCheck }

// Vercel's documented defaults, used only when the configuration call returns
// no recommendation (https://vercel.com/docs/domains/working-with-domains/add-a-domain).
const DEFAULT_A = "76.76.21.21"
const DEFAULT_CNAME = "cname.vercel-dns.com"

// https://vercel.com/docs/rest-api/projects/retrieve-project-domains-by-project-by-id-or-name
export async function listVercelDomains(projectPath: string, options: DomainOptions = {}) {
  const context = await vercelLinkContext(projectPath)
  const items = await vercelPages(
    context.auth,
    `/v9/projects/${encodeURIComponent(context.link.projectId)}/domains`,
    "domains",
    { cursor: "until", request: options.request },
  )
  const domains = await Promise.all(items.map((item) => describeDomain(context, item, options)))
  return { project: context.link.projectName, domains }
}

async function describeDomain(context: VercelLinkContext, domain: unknown, options: DomainOptions) {
  const name = stringField(domain, "name") ?? ""
  const apexName = stringField(domain, "apexName") ?? name
  const verified = booleanField(domain, "verified") === true
  // https://vercel.com/docs/rest-api/domains/get-a-domain-s-configuration
  const config = await vercelRequest(context.auth, `/v6/domains/${encodeURIComponent(name)}/config`, {
    query: { projectIdOrName: context.link.projectId },
    request: options.request,
  }).catch(() => undefined)
  const configured = Boolean(config) && booleanField(config, "misconfigured") === false
  const apex = name === apexName
  const routing: VercelDnsRecord = apex
    ? { type: "A", name: "@", value: recommended(config, "recommendedIPv4") ?? DEFAULT_A, purpose: "routing" }
    : {
        type: "CNAME",
        name: name.slice(0, -(apexName.length + 1)) || name,
        value: recommended(config, "recommendedCNAME") ?? DEFAULT_CNAME,
        purpose: "routing",
      }
  const verification = arrayField(domain, "verification").flatMap((record): VercelDnsRecord[] => {
    const type = stringField(record, "type")?.toUpperCase()
    const host = stringField(record, "domain")
    const value = stringField(record, "value")
    if (!host || !value || (type !== "TXT" && type !== "CNAME" && type !== "A")) return []
    return [{ type, name: host, value, purpose: "verification" }]
  })
  const status = !verified ? "needs_verification" : configured ? "ready" : "needs_dns"
  const certificate = status === "ready" ? await (options.certificate ?? checkCertificate)(name) : undefined
  return {
    name,
    apex,
    verified,
    configured,
    status,
    records: [routing, ...verification],
    certificate,
    redirect: stringField(domain, "redirect"),
    gitBranch: stringField(domain, "gitBranch"),
    detail:
      status === "needs_verification"
        ? "Add the TXT record to prove you own the domain, then verify."
        : status === "needs_dns"
          ? `Add the ${routing.type} record at your DNS provider. Changes can take a while to spread.`
          : certificate?.status === "issued"
            ? "Serving over HTTPS."
            : "DNS is correct; Vercel is issuing the certificate.",
  } satisfies VercelDomain
}

// rank 1 is Vercel's preferred value; an IPv4 recommendation lists addresses.
function recommended(config: unknown, key: "recommendedIPv4" | "recommendedCNAME") {
  const ranked = arrayField(config, key).toSorted(
    (left, right) => (numberField(left, "rank") ?? 99) - (numberField(right, "rank") ?? 99),
  )
  for (const item of ranked) {
    const value = Reflect.get(item as object, "value")
    const first = Array.isArray(value) ? value.find((entry): entry is string => typeof entry === "string") : value
    if (typeof first === "string" && first) return first.replace(/\.$/, "")
  }
  return undefined
}

// The certificate the domain actually serves, read from a TLS handshake.
export function checkCertificate(domain: string): Promise<VercelCertificate> {
  return new Promise((resolve) => {
    const socket = connect({ host: domain, port: 443, servername: domain, timeout: 5_000 }, () => {
      const certificate = socket.getPeerCertificate()
      const authorized = socket.authorized
      socket.end()
      if (!authorized || !certificate?.valid_to) {
        resolve({ status: "pending", detail: "The domain does not serve a trusted certificate yet." })
        return
      }
      resolve({
        status: "issued",
        expiresAt: new Date(certificate.valid_to).toISOString(),
        issuer: typeof certificate.issuer?.O === "string" ? certificate.issuer.O : undefined,
      })
    })
    socket.on("timeout", () => {
      socket.destroy()
      resolve({ status: "pending", detail: "The domain did not answer on HTTPS." })
    })
    socket.on("error", () => resolve({ status: "pending", detail: "The domain does not serve HTTPS yet." }))
  })
}

// https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project
export async function addVercelDomain(projectPath: string, raw: string, options: DomainOptions = {}) {
  const domain = normalizeCloudDomain(raw)
  const context = await vercelLinkContext(projectPath)
  const added = await vercelRequest(
    context.auth,
    `/v10/projects/${encodeURIComponent(context.link.projectId)}/domains`,
    {
      method: "POST",
      body: { name: domain },
      request: options.request,
    },
  )
  return { project: context.link.projectName, domain: await describeDomain(context, added, options) }
}

// https://vercel.com/docs/rest-api/projects/verify-project-domain
export async function verifyVercelDomain(projectPath: string, raw: string, options: DomainOptions = {}) {
  const domain = normalizeCloudDomain(raw)
  const context = await vercelLinkContext(projectPath)
  const path = `/v9/projects/${encodeURIComponent(context.link.projectId)}/domains/${encodeURIComponent(domain)}`
  const current = await vercelRequest(context.auth, path, { request: options.request })
  const verified =
    booleanField(current, "verified") === true
      ? current
      : await vercelRequest(context.auth, `${path}/verify`, { method: "POST", request: options.request }).catch(
          (error: unknown) => {
            // Vercel answers 400 while the TXT record is not visible yet.
            if (error instanceof VercelError && error.code === "invalid") return current
            throw error
          },
        )
  return { project: context.link.projectName, domain: await describeDomain(context, verified, options) }
}

// https://vercel.com/docs/rest-api/projects/remove-a-domain-from-a-project
export async function removeVercelDomain(projectPath: string, raw: string, options: DomainOptions = {}) {
  const domain = normalizeCloudDomain(raw)
  const context = await vercelLinkContext(projectPath)
  await vercelRequest(
    context.auth,
    `/v9/projects/${encodeURIComponent(context.link.projectId)}/domains/${encodeURIComponent(domain)}`,
    { method: "DELETE", request: options.request },
  )
  return { project: context.link.projectName, removed: domain }
}
