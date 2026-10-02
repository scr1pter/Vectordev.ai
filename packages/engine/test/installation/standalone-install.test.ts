import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const installer = path.resolve(import.meta.dir, "../../../web/public/install")
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vector installer '"))
  const tools = path.join(directory, "tools")
  const files = path.join(directory, "files")
  const destination = path.join(directory, "install with spaces")
  await mkdir(tools)
  await mkdir(files)
  for (const command of [
    "tar",
    // GNU tar invokes gzip through PATH; keep it available in the no-Node fixture.
    "gzip",
    "awk",
    "cut",
    "sort",
    "cmp",
    "wc",
    "grep",
    "mktemp",
    "tr",
    "mkdir",
    "cp",
    "mv",
    "chmod",
    "rm",
    "rmdir",
    "shasum",
    "find",
  ]) {
    const actual = Bun.which(command)
    if (!actual) throw new Error(`Missing test prerequisite ${command}`)
    await symlink(actual, path.join(tools, command))
  }
  const script = async (name: string, body: string) => {
    await rm(path.join(tools, name), { force: true })
    await Bun.write(path.join(tools, name), `#!/bin/sh\nset -eu\n${body}\n`)
    await chmod(path.join(tools, name), 0o755)
  }
  await script(
    "uname",
    'case "$1" in -s) printf "%s\\n" "${TEST_OS:-Linux}" ;; -m) printf "%s\\n" "${TEST_ARCH:-x86_64}" ;; esac',
  )
  await script("ldd", 'printf "%s\\n" "${TEST_LIBC:-glibc}"')
  await script("getconf", '[ "${TEST_LIBC:-glibc}" = glibc ] && printf "glibc 2.31\\n"')
  await script(
    "curl",
    `output=; url=
while [ "$#" -gt 0 ]; do
 case "$1" in --output) output=$2; shift 2 ;; https://*) url=$1; shift ;; *) shift ;; esac
done
printf '%s\\n' "$url" >> ${quote(path.join(directory, "requests"))}
case "$url" in *'/api/cli-release?'*) cp ${quote(path.join(directory, "release.tsv"))} "$output" ;; *) cp ${quote(path.join(directory, "archive.tar.gz"))} "$output" ;; esac
printf '%s' "\${TEST_HTTP_STATUS:-200}"`,
  )
  const version = "1.99.42"
  await Bun.write(path.join(files, "vector"), `#!/bin/sh\nprintf '%s\\n' ${quote(version)}\n`)
  await chmod(path.join(files, "vector"), 0o755)
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
    await Bun.write(path.join(files, name), name)
  const archive = async (
    names = ["vector", "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"],
    target = "linux-x64-baseline",
  ) => {
    const process = Bun.spawn(
      [Bun.which("tar")!, "-czf", path.join(directory, "archive.tar.gz"), "-C", files, ...names],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await process.exited, await new Response(process.stderr).text()).toBe(0)
    const bytes = await Bun.file(path.join(directory, "archive.tar.gz")).bytes()
    await Bun.write(
      path.join(directory, "release.tsv"),
      `${version}\t${target}\thttps://fixture.public.blob.vercel-storage.com/releases/vector-cli/v${version}/vector-${target}.tar.gz\t${bytes.length}\t${createHash("sha256").update(bytes).digest("hex")}\n`,
    )
  }
  await archive()
  return {
    directory,
    files,
    destination,
    version,
    archive,
    script,
    async run(args: string[] = [], env: Record<string, string> = {}) {
      const process = Bun.spawn(["/bin/sh", installer, "--install-dir", destination, ...args], {
        env: { PATH: tools, HOME: directory, ...env },
        stdout: "pipe",
        stderr: "pipe",
      })
      return {
        code: await process.exited,
        output: await new Response(process.stdout).text(),
        error: await new Response(process.stderr).text(),
      }
    },
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("POSIX installer uses no Node, installs an exact immutable artifact and owns only its receipt files", async () => {
  await using install = await fixture()
  const result = await install.run(["--version", install.version, "--binary-name", "vector-native"])
  expect(result.code, result.error).toBe(0)
  const receipt = await Bun.file(path.join(install.destination, ".vector-vector-native/receipt.tsv")).text()
  expect(receipt.split("\t").slice(0, 6)).toEqual([
    "vector-standalone",
    "1",
    install.version,
    "linux-x64-baseline",
    "latest",
    "vector-native",
  ])
  expect(receipt.split("\t")[6]).toBe(
    createHash("sha256")
      .update(await Bun.file(path.join(install.destination, "vector-native")).bytes())
      .digest("hex"),
  )
  expect(await Bun.file(path.join(install.directory, "requests")).text()).toContain(
    `version=${install.version}&target=linux-x64-baseline&format=tsv`,
  )
  expect((await install.run(["--version", install.version, "--binary-name", "vector-native"])).code).toBe(0)
})

test("POSIX installer rejects bad checksum, extra archive entries, redirects and unrelated installs", async () => {
  await using install = await fixture()
  const metadata = await Bun.file(path.join(install.directory, "release.tsv")).text()
  await Bun.write(
    path.join(install.directory, "release.tsv"),
    metadata.replace(/[a-f0-9]{64}\n$/, "0".repeat(64) + "\n"),
  )
  expect((await install.run()).error).toContain("checksum did not match")
  expect(await Bun.file(path.join(install.destination, "vector")).exists()).toBe(false)
  await Bun.write(path.join(install.files, "unexpected"), "unrelated")
  await install.archive(["vector", "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md", "unexpected"])
  expect((await install.run()).error).toContain("unexpected paths")
  await install.archive()
  expect((await install.run([], { TEST_HTTP_STATUS: "302" })).error).toContain("unexpected status or redirect")
  await Bun.write(path.join(install.destination, "vector"), "unrelated executable")
  expect((await install.run()).error).toContain("without a valid standalone receipt")
  expect(await Bun.file(path.join(install.destination, "vector")).text()).toBe("unrelated executable")
})

test("POSIX installer retains a working receipt-owned binary on version mismatch", async () => {
  await using install = await fixture()
  expect((await install.run()).code).toBe(0)
  const prior = await Bun.file(path.join(install.destination, "vector")).text()
  await Bun.write(path.join(install.files, "vector"), "#!/bin/sh\nprintf '9.0.0\\n'\n")
  await install.archive()
  const result = await install.run()
  expect(result.code).toBe(1)
  expect(result.error).toContain("reports a different version")
  expect(await Bun.file(path.join(install.destination, "vector")).text()).toBe(prior)
  await Bun.write(path.join(install.files, "vector"), `#!/bin/sh\nprintf '%s\\n' ${quote(install.version)}\nexit 1\n`)
  await install.archive()
  expect((await install.run()).error).toContain("could not report its version")
  expect(await Bun.file(path.join(install.destination, "vector")).text()).toBe(prior)
})

test("POSIX installer rejects linked archive entries and mismatched archive sizes before execution", async () => {
  await using install = await fixture()
  await rm(path.join(install.files, "vector"))
  await symlink("LICENSE", path.join(install.files, "vector"))
  await install.archive()
  expect((await install.run()).error).toContain("links and special files are forbidden")
  expect(await Bun.file(path.join(install.destination, "vector")).exists()).toBe(false)
  const metadata = (await Bun.file(path.join(install.directory, "release.tsv")).text()).split("\t")
  metadata[3] = String(Number(metadata[3]) + 1)
  await Bun.write(path.join(install.directory, "release.tsv"), metadata.join("\t"))
  expect((await install.run()).error).toContain("size did not match")
})

test("POSIX installer selects musl arm64 and macOS baseline artifacts", async () => {
  await using install = await fixture()
  await install.archive(undefined, "linux-arm64-musl")
  expect((await install.run([], { TEST_ARCH: "aarch64", TEST_LIBC: "musl" })).code).toBe(0)
  await install.archive(undefined, "darwin-x64-baseline")
  expect((await install.run([], { TEST_OS: "Darwin" })).code).toBe(0)
})

test("POSIX installer preserves hidden metadata files and beta channel intent", async () => {
  await using install = await fixture()
  expect((await install.run(["--version", "beta"])).code).toBe(0)
  expect((await Bun.file(path.join(install.destination, ".vector-vector/receipt.tsv")).text()).split("\t")[4]).toBe(
    "beta",
  )
  expect((await install.run(["--version", install.version])).code).toBe(0)
  expect((await Bun.file(path.join(install.destination, ".vector-vector/receipt.tsv")).text()).split("\t")[4]).toBe(
    "beta",
  )
  await Bun.write(path.join(install.destination, ".vector-vector/.user-file"), "preserve")
  expect((await install.run()).error).toContain("unrelated files")
  expect(await Bun.file(path.join(install.destination, ".vector-vector/.user-file")).text()).toBe("preserve")
})

for (const boundary of ["binary", "metadata"]) {
  test(`POSIX installer rolls back a signal immediately after ${boundary} replacement`, async () => {
    await using install = await fixture()
    expect((await install.run()).code).toBe(0)
    const previous = await Bun.file(path.join(install.destination, "vector")).text()
    await Bun.write(path.join(install.files, "vector"), `${previous}# Updated bytes\n`)
    await install.archive()
    const actual = Bun.which("mv")!
    await install.script(
      "mv",
      `${quote(actual)} "$@"\nfor argument in "$@"; do\n case "$argument" in *${boundary === "binary" ? "/extracted/vector" : "/new-metadata"}) kill -TERM "$PPID" ;; esac\ndone`,
    )
    expect((await install.run()).code).toBe(1)
    expect(await Bun.file(path.join(install.destination, "vector")).text()).toBe(previous)
    expect(await Bun.file(path.join(install.destination, ".vector-vector/receipt.tsv")).exists()).toBe(true)
  })
}

test("POSIX installer retains recovery backups when rollback itself fails", async () => {
  await using install = await fixture()
  expect((await install.run()).code).toBe(0)
  const previous = await Bun.file(path.join(install.destination, "vector")).text()
  await Bun.write(path.join(install.files, "vector"), `${previous}# Updated bytes\n`)
  await install.archive()
  const actual = Bun.which("mv")!
  await install.script(
    "mv",
    `for argument in "$@"; do case "$argument" in */old-binary) exit 1 ;; esac; done\n${quote(actual)} "$@"\nfor argument in "$@"; do case "$argument" in */extracted/vector) kill -TERM "$PPID" ;; esac; done`,
  )
  const result = await install.run()
  expect(result.code).toBe(1)
  expect(result.error).toContain("Recovery files were preserved")
  const backups = await Array.fromAsync(
    new Bun.Glob(".vector-stage.*/old-binary").scan({ cwd: install.destination, dot: true, absolute: true }),
  )
  expect(backups).toHaveLength(1)
  expect(await Bun.file(backups[0]!).text()).toBe(previous)
})
