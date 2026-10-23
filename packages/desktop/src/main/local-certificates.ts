import { X509Certificate } from "node:crypto"
import { readFileSync } from "node:fs"

// A company's certificate authorities (Vector Local's `ca.files`, plan section 4.9), for desktop main and the engine
// sidecar. They are added to the certificates Node already trusts (its bundled list and the system's), never in their
// place, so public sites keep working behind a company's TLS inspection. Chromium uses the system's store instead, so
// Vector's windows trust what the system trusts.

const BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/**
 * `base` with the certificate authorities in `files` added after it, each once. A file Vector cannot read, a block that
 * is not a certificate and a certificate that is not an authority are left out and named in `problems`.
 */
export function companyCertificates(
  base: readonly string[],
  files: readonly string[],
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
) {
  const problems: string[] = []
  const known = new Set(base.map(fingerprint))
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
  return { certificates: [...base, ...added], added, problems }
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
