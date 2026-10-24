import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"
import tls from "node:tls"
import { LocalStartup } from "@vectordevai/core/local-mode/startup"
import { desktopLocalFolders } from "./local-policy"

// The certificate authorities Vector Local names (`ca.files`, plan section 4.9), for desktop main and the engine
// sidecar, which both trust them through `trustCompanyCertificates`. They are added to the certificates Node already
// trusts (its bundled list and the system's), never in their place, so public sites keep working behind a company's
// TLS inspection. Company policy an administrator alone could have written applies at once. The user's own config
// applies unless the company locks Vector Local, and only for an authority its owner trusted: anything that can write
// that config, an agent's shell command included, could otherwise have Vector accept a certificate it made. Desktop main
// asks the owner about each new one (watchCompanyCertificates), keeps the answers by fingerprint, and hands them to its
// engine as it starts it. Chromium uses the system's store instead, so Vector's windows trust what the system trusts.

/** A certificate authority the user's own config names that its owner has not trusted yet. */
export type WaitingAuthority = {
  /** SHA-256 of the certificate, as `confirmed` lists it once trusted. */
  readonly fingerprint: string
  readonly subject: string
  readonly file: string
}

/**
 * The certificates Node trusts in this process: its bundled list and the system's, with the certificate authorities
 * Vector Local names added after them (companyAuthorities). `apply` is Node's setDefaultCACertificates.
 */
export function trustCompanyCertificates(input: {
  readonly userData: string
  /** The fingerprints of the user's own certificate authorities its owner trusted. */
  readonly confirmed: readonly string[]
  readonly apply?: (certificates: string[]) => void
  readonly folders?: LocalStartup.Input
}) {
  const base = [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])]
  const named = companyAuthorities({
    folders: input.folders ?? desktopLocalFolders(input.userData),
    confirmed: input.confirmed,
    base,
  })
  const certificates = [...base, ...named.added]
  ;(input.apply ?? ((list: string[]) => tls.setDefaultCACertificates(list)))(certificates)
  return { ...named, certificates }
}

/**
 * The certificate authorities Vector Local names that are not in `base`: company policy's, and the user's own config's
 * that its owner trusted (`confirmed`), in `added`; the user's own that wait for the owner in `waiting`.
 */
export function companyAuthorities(input: {
  readonly folders: LocalStartup.Input
  readonly confirmed: readonly string[]
  readonly base?: readonly string[]
}) {
  const named = LocalStartup.authorities(input.folders)
  const company = companyCertificates(input.base ?? [], named.company)
  const user = companyCertificates(company.certificates, named.user)
  const own = user.found.map((item) => {
    const certificate = new X509Certificate(item.pem)
    return {
      pem: item.pem,
      authority: {
        fingerprint: certificate.fingerprint256,
        subject: certificate.subject.replaceAll("\n", ", "),
        file: item.file,
      } satisfies WaitingAuthority,
    }
  })
  const trusted = (item: (typeof own)[number]) => input.confirmed.includes(item.authority.fingerprint)
  return {
    added: [...company.added, ...own.filter(trusted).map((item) => item.pem)],
    waiting: own.filter((item) => !trusted(item)).map((item) => item.authority),
    problems: [...company.problems, ...user.problems],
  }
}

const BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/**
 * `base` with the certificate authorities in `files` added after it, each once, and the file each came from (`found`).
 * A file Vector cannot read, a block that is not a certificate and a certificate that is not an authority are left out
 * and named in `problems`.
 */
export function companyCertificates(
  base: readonly string[],
  files: readonly string[],
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
) {
  const problems: string[] = []
  const known = new Set(base.map(fingerprint))
  const found = files.flatMap((file) => {
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
      return [{ file, pem }]
    })
  })
  const added = found.map((item) => item.pem)
  return { certificates: [...base, ...added], added, found, problems }
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
