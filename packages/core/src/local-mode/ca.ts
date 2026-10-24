export * as LocalCA from "./ca"

import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import tls from "node:tls"
import { LocalStartup } from "./startup"

// The certificate authorities a company's policy names (`local.ca.files`, plan section 4.9), for Vector under Bun: the
// CLI, the terminal UI and `vector serve`. Node adds them to what every connection trusts (tls.setDefaultCACertificates,
// which desktop main and its engine use), but Bun has no such call, so the list goes with each request instead:
// Egress.fetch, which every labelled request and every model call goes through, passes it as Bun's `tls.ca`. A `ca`
// replaces the certificates Bun trusts by default, so the list is Bun's own and the system's first, then the
// company's, and public sites keep working behind a company's TLS inspection.
//
// Only company policy that an administrator alone could have written counts here (LocalStartup.authorities). The user's
// own config may name certificate authorities too, but anything that can write that config, an agent's shell command
// included, could then have Vector accept a certificate it made. The desktop app trusts each of those only once its
// owner has; in a terminal, NODE_EXTRA_CA_CERTS (which Bun reads when it starts) adds one the user chose. The files are
// read once per process, so a change applies at the next start, as it does in the desktop app.

export type Authorities = {
  /** Bun's own certificates and the system's, then the company's that are not among them. Empty without any. */
  readonly certificates: readonly string[]
  /** The company's, in the order the policy names their files. */
  readonly added: readonly string[]
  /** Files Vector could not read, blocks that are not certificates and certificates that are not authorities. */
  readonly problems: readonly string[]
}

const BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** The certificate list for the certificate authorities in `files`, read with `read`. */
export function authorities(
  files: readonly string[],
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): Authorities {
  const base = defaults()
  const known = new Set(base.map(fingerprint))
  const problems: string[] = []
  const added = files.flatMap((file) => {
    const text = readable(() => read(file))
    if (text === undefined) {
      problems.push(`Vector could not read the certificate file ${file}.`)
      return []
    }
    const blocks = text.match(BLOCK) ?? []
    if (blocks.length === 0) problems.push(`${file} holds no PEM certificate.`)
    return blocks.flatMap((pem) => {
      const certificate = readable(() => new X509Certificate(pem))
      if (!certificate) {
        problems.push(`${file} holds a block that is not a certificate.`)
        return []
      }
      if (!certificate.ca) {
        problems.push(
          `${file} holds a certificate for ${certificate.subject.replaceAll("\n", ", ")}, not an authority.`,
        )
        return []
      }
      const key = fingerprint(pem)
      if (known.has(key)) return []
      known.add(key)
      return [pem]
    })
  })
  return { certificates: added.length > 0 ? [...base, ...added] : [], added, problems }
}

const state: { company?: Authorities } = {}

/** The company's certificate authorities for this process, read the first time a request asks. */
export function company() {
  state.company ??= authorities(LocalStartup.authorities().company)
  return state.company
}

/**
 * `init` with the company's certificate authorities added under Bun, for a fetch. Unchanged under Node, where they
 * are already trusted, without any, or when the request names its own `ca`.
 */
export function request<T extends RequestInit>(init: T, list?: Authorities): T {
  if (typeof Bun === "undefined") return init
  const given = (init as { tls?: Record<string, unknown> }).tls
  if (given?.ca !== undefined) return init
  const named = list ?? company()
  if (named.added.length === 0) return init
  return { ...init, tls: { ...given, ca: [...named.certificates] } }
}

// What Bun trusts without a `ca`: its bundled list, NODE_EXTRA_CA_CERTS and, when Bun is told to, the system's.
function defaults() {
  const read = (kind: "default" | "system") => readable(() => tls.getCACertificates(kind)) ?? []
  const all = [...read("default"), ...read("system")]
  return [...new Set(all.length > 0 ? all : tls.rootCertificates)]
}

// The same certificate written with other line breaks is the same certificate.
function fingerprint(pem: string) {
  return pem.replace(/\s+/g, "")
}

function readable<T>(run: () => T) {
  try {
    return run()
  } catch {
    return undefined
  }
}
