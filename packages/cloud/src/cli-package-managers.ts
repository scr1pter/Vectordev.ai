import path from "node:path"
import { mkdir } from "node:fs/promises"
import { CliRelease } from "@vectordevai/schema/cli-release"

export function cliPackageManagers(input: {
  manifest: unknown
  tapRepository: string
  scoopRepository: string
  scoopBucket: string
}) {
  const manifest = CliRelease.decode(input.manifest)
  if (manifest.channel !== "latest")
    throw new Error("The stable package-manager definitions require a stable CLI release.")
  for (const repository of [input.tapRepository, input.scoopRepository])
    if (
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) ||
      repository.endsWith(".git")
    )
      throw new Error("Provide the actual owner-created GitHub repositories as owner/repository.")
  const tap = input.tapRepository.split("/")
  if (!/^homebrew-[A-Za-z0-9][A-Za-z0-9-]*$/.test(tap[1]!))
    throw new Error("The owner-created Homebrew repository name must start with homebrew-.")
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(input.scoopBucket))
    throw new Error("Provide an explicit Scoop bucket name using letters, digits and hyphens.")
  const tapName = `${tap[0]}/${tap[1]!.slice("homebrew-".length)}`
  const formula = `# Generated from the immutable Vector CLI ${manifest.version} manifest.
# Source revision: ${manifest.sourceRevision}; catalog SHA-256: ${manifest.catalogSha256}
class Vector < Formula
  desc "AI coding agent for your terminal"
  homepage "https://vectordev.ai"
  version "${manifest.version}"
  license :cannot_represent

${(["macos", "linux"] as const)
  .map(
    (os) => `  on_${os} do
${(["arm", "intel"] as const)
  .map((arch) => {
    const target = `${os === "macos" ? "darwin" : "linux"}-${arch === "arm" ? "arm64" : "x64-baseline"}`
    const asset = manifest.targets[target]!
    return `    on_${arch} do
      url "${asset.url}"
      sha256 "${asset.sha256}"
    end`
  })
  .join("\n")}
  end`,
  )
  .join("\n\n")}

  def install
    bin.install "vector"
    (pkgshare/"licenses").install "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/vector --version").strip
  end
end
`
  const scoop =
    JSON.stringify(
      {
        "##": `Generated from Vector CLI ${manifest.version}; source ${manifest.sourceRevision}; catalog ${manifest.catalogSha256}.`,
        version: manifest.version,
        description: "AI coding agent for your terminal",
        homepage: "https://vectordev.ai",
        license: { identifier: "Proprietary", url: "https://vectordev.ai/legal/license" },
        architecture: Object.fromEntries(
          (
            [
              ["64bit", "windows-x64-baseline"],
              ["arm64", "windows-arm64"],
            ] as const
          ).map(([arch, target]) => [
            arch,
            {
              url: manifest.targets[target]!.url,
              hash: manifest.targets[target]!.sha256,
            },
          ]),
        ),
        bin: "vector.exe",
      },
      null,
      2,
    ) + "\n"
  const readme = `# Vector CLI ${manifest.version} package channels

These files are generated from the immutable release manifest. Publish them only after that complete twelve-target release has been verified and committed. The repository coordinates below were supplied explicitly; this generator does not create repositories or verify owner control.

Copy \`homebrew/Formula/vector.rb\` to \`Formula/vector.rb\` in https://github.com/${input.tapRepository}.
Copy \`scoop/bucket/vector.json\` to \`bucket/vector.json\` in https://github.com/${input.scoopRepository}.

After those repositories and this release are live:

\`\`\`sh
brew install ${tapName}/vector
brew upgrade ${tapName}/vector
brew uninstall ${tapName}/vector
\`\`\`

\`\`\`powershell
scoop bucket add ${input.scoopBucket} https://github.com/${input.scoopRepository}
scoop install ${input.scoopBucket}/vector
scoop update vector
scoop uninstall vector
\`\`\`

The package managers own installed files and their normal receipts. No standalone-installer receipt is created. Homebrew retains notices under its package share/licenses directory; Scoop retains them alongside vector.exe. Intel targets use baseline binaries for CPU compatibility. Homebrew Linux targets use glibc; musl users use the standalone installer. These stable definitions deliberately use immutable versioned URLs and exact hashes; regenerate and review them for every release. No unchecked autoupdate or moving binary URL is emitted.

Vector's commercial license: https://vectordev.ai/legal/license. Bundled third-party licenses remain in the included notices. Creating these files does not change the product's license or subscription model.
`
  return { formula, scoop, readme }
}

if (import.meta.main) {
  const required = (name: string) => {
    const value = process.env[name]
    if (!value) throw new Error(`${name} is required.`)
    return value
  }
  const manifest = Bun.file(required("VECTOR_CLI_MANIFEST"))
  if (manifest.size > CliRelease.MAX_MANIFEST_BYTES) throw new Error("The CLI manifest exceeds the size limit.")
  const generated = cliPackageManagers({
    manifest: await manifest.json(),
    tapRepository: required("VECTOR_HOMEBREW_REPOSITORY"),
    scoopRepository: required("VECTOR_SCOOP_REPOSITORY"),
    scoopBucket: required("VECTOR_SCOOP_BUCKET"),
  })
  const output = path.resolve(required("VECTOR_CLI_MANAGERS_DIR"))
  await mkdir(path.join(output, "homebrew/Formula"), { recursive: true })
  await mkdir(path.join(output, "scoop/bucket"), { recursive: true })
  await Bun.write(path.join(output, "homebrew/Formula/vector.rb"), generated.formula)
  await Bun.write(path.join(output, "scoop/bucket/vector.json"), generated.scoop)
  await Bun.write(path.join(output, "README.md"), generated.readme)
  console.log(`Generated Vector CLI package definitions in ${output}`)
}
