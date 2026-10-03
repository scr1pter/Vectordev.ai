import path from "node:path"
import { catalogBody, catalogDigest } from "./release-catalog"

/** The fallback is a reviewed application Git blob, never a working-tree file or a live data service. */
export async function committedCatalog(
  input: { directory: string; forkRepository?: string; forkRevision?: string } = {
    directory: path.resolve(import.meta.dirname, "../../.."),
    forkRepository: process.env.VECTOR_CATALOG_FORK_REPOSITORY,
    forkRevision: process.env.VECTOR_CATALOG_FORK_REVISION,
  },
) {
  if (input.forkRepository || input.forkRevision)
    throw new Error("The committed catalog fallback requires both catalog fork variables to be unset")
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-C", input.directory, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`Cannot read the committed release catalog: ${error.trim()}`)
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output)
  }
  const revision = (await git(["rev-parse", "HEAD"])).trim()
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("The application checkout must have a full commit SHA")
  const source = "packages/web/public/models/api.json"
  const entry = (await git(["ls-tree", revision, "--", source])).trimEnd()
  if (!entry.startsWith("100644 blob ") || !entry.endsWith(`\t${source}`))
    throw new Error("The release source must contain a regular committed packages/web/public/models/api.json")
  const text = await git(["show", `${revision}:${source}`])
  if (catalogBody(text) !== text) throw new Error("The committed release catalog is not a prepared Vector snapshot")
  const sha256 = catalogDigest(text)
  return { text, provenance: { source: "application-git", revision, path: source, sha256 } }
}

if (import.meta.main) {
  const output = process.argv[2]
  if (!output) throw new Error("Provide the output path for the committed release catalog")
  const prepared = await committedCatalog()
  await Bun.write(output, prepared.text)
  await Bun.write(`${output}.provenance.json`, JSON.stringify(prepared.provenance, null, 2) + "\n")
  console.log(`Read committed Vector catalog ${prepared.provenance.revision}; sha256=${prepared.provenance.sha256}`)
}
