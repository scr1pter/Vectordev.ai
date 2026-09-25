import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdtemp, mkdir, readdir, rm, symlink, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { shellEscape, wslInstallScript, wslToolsProbeScript, wslResolveScript } from "./scripts"
import { requireWslAuthentication } from "./startup"

const shellTest = process.platform === "win32" ? test.skip : test
const installer = path.resolve(import.meta.dir, "../../../../web/public/install")

async function fixture(arch = "x64", version = "1.16.2") {
  const home = await mkdtemp(path.join(os.tmpdir(), "vector wsl '"))
  const bin = path.join(home, "tools")
  const files = path.join(home, "archive")
  await mkdir(bin)
  await mkdir(files)
  for (const command of [
    "sh",
    "tar",
    "awk",
    "sed",
    "cut",
    "sort",
    "cmp",
    "wc",
    "grep",
    "find",
    "mktemp",
    "tr",
    "mkdir",
    "cp",
    "mv",
    "chmod",
    "rm",
    "rmdir",
    "shasum",
  ]) {
    const actual = Bun.which(command)
    if (!actual) throw new Error(`Missing fixture utility ${command}`)
    await symlink(actual, path.join(bin, command))
  }
  const script = async (name: string, body: string) => {
    await Bun.write(path.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`)
    await chmod(path.join(bin, name), 0o755)
  }
  await script("uname", `case "$1" in -s) printf Linux ;; -m) printf ${arch === "x64" ? "x86_64" : "aarch64"} ;; esac`)
  await script("ldd", "printf 'glibc\\n'")
  await script("getconf", "printf 'glibc 2.31\\n'")
  await script(
    "curl",
    `output=; url=; status=false
while [ "$#" -gt 0 ]; do
 case "$1" in --output) output=$2; shift 2 ;; --write-out) status=true; shift 2 ;; https://*) url=$1; shift ;; *) shift ;; esac
done
printf '%s\\n' "$url" >> "$HOME/requests"
case "$url" in
 https://vectordev.ai/install) cp ${shellEscape(installer)} "$output" ;;
 'https://vectordev.ai/api/cli-release?'*) cp "$HOME/release.tsv" "$output" ;;
 https://fixture.public.blob.vercel-storage.com/*) cp "$HOME/archive.tar.gz" "$output" ;;
 *) exit 1 ;;
esac
if [ "$status" = true ]; then printf 200; fi`,
  )
  const writeArchive = async (reported = version) => {
    await Bun.write(path.join(files, "vector"), `#!/bin/sh\nprintf '%s\\n' ${shellEscape(reported)}\n`)
    await chmod(path.join(files, "vector"), 0o755)
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
      await Bun.write(path.join(files, name), name)
    const child = Bun.spawn(
      [
        Bun.which("tar")!,
        "-czf",
        path.join(home, "archive.tar.gz"),
        "-C",
        files,
        "vector",
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "DEPENDENCY_NOTICES.md",
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    const bytes = await Bun.file(path.join(home, "archive.tar.gz")).bytes()
    const target = arch === "x64" ? "linux-x64-baseline" : "linux-arm64"
    await Bun.write(
      path.join(home, "release.tsv"),
      `${version}\t${target}\thttps://fixture.public.blob.vercel-storage.com/releases/vector-cli/v${version}/vector-${target}.tar.gz\t${bytes.length}\t${createHash("sha256").update(bytes).digest("hex")}\n`,
    )
  }
  await writeArchive()
  return {
    home,
    bin,
    writeArchive,
    async run(script: string) {
      const child = Bun.spawn(["/bin/bash", "-c", script], {
        env: { HOME: home, PATH: `/mnt/c/untrusted:${bin}` },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, code }
    },
    async [Symbol.asyncDispose]() {
      await rm(home, { recursive: true, force: true })
    },
  }
}

for (const arch of ["x64", "arm64"]) {
  shellTest(`${arch}: generated WSL bootstrap runs the actual exact-version installer without Node/npm`, async () => {
    await using instance = await fixture(arch)
    expect(await instance.run(wslToolsProbeScript())).toMatchObject({ code: 0, stdout: "yes" })
    const result = await instance.run(wslInstallScript("1.16.2"))
    expect(result.code, result.stderr).toBe(0)
    const receipt = await Bun.file(path.join(instance.home, ".vector/bin/.vector-vector-native/receipt.tsv")).text()
    expect(receipt.split("\t").slice(0, 3)).toEqual(["vector-standalone", "1", "1.16.2"])
    expect(receipt.split("\t")[5]).toBe("vector-native")
    const resolved = await instance.run(wslResolveScript())
    expect(resolved.stdout.trim()).toBe(path.join(instance.home, ".vector/bin/vector-native"))
    const requests = await Bun.file(path.join(instance.home, "requests")).text()
    expect(requests).toContain("https://vectordev.ai/install\n")
    expect(requests).toContain("version=1.16.2&target=linux-")
  })
}

shellTest("missing download/hash tools block installation with useful guidance", async () => {
  await using instance = await fixture()
  await unlink(path.join(instance.bin, "shasum"))
  expect(await instance.run(wslToolsProbeScript())).toMatchObject({ code: 0, stdout: "no" })
  expect(await instance.run(wslInstallScript("1.16.2"))).toMatchObject({
    code: 1,
    stderr: expect.stringContaining("curl, tar and SHA-256 tools"),
  })
  expect(await Bun.file(path.join(instance.home, "requests")).exists()).toBe(false)
})

shellTest("a bad release cannot replace a working WSL executable", async () => {
  await using instance = await fixture()
  expect((await instance.run(wslInstallScript("1.16.2"))).code).toBe(0)
  const native = path.join(instance.home, ".vector/bin/vector-native")
  const before = await Bun.file(native).text()
  await instance.writeArchive("9.9.9")
  const result = await instance.run(wslInstallScript("1.16.2"))
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("reports a different version")
  expect(await Bun.file(native).text()).toBe(before)
})

shellTest("an older Node launcher is not accepted as the native WSL server", async () => {
  await using instance = await fixture()
  await Bun.write(path.join(instance.home, ".vector/bin/vector"), "#!/usr/bin/env node\n")
  await chmod(path.join(instance.home, ".vector/bin/vector"), 0o755)
  expect(await instance.run(wslResolveScript())).toMatchObject({ code: 0, stdout: "" })
})

shellTest("the dedicated unreceipted managed WSL binary upgrades after candidate verification", async () => {
  await using instance = await fixture()
  const native = path.join(instance.home, ".vector/bin/vector-native")
  await Bun.write(native, "#!/bin/sh\nprintf '1.0.0\\n'\n")
  await chmod(native, 0o755)
  await Bun.write(path.join(instance.home, ".vector/bin/vector"), "unrelated launcher")
  const result = await instance.run(wslInstallScript("1.16.2"))
  expect(result.code, result.stderr).toBe(0)
  expect(await Bun.file(native).text()).toContain("1.16.2")
  expect(await Bun.file(path.join(instance.home, ".vector/bin/vector")).text()).toBe("unrelated launcher")
  expect(await Bun.file(path.join(instance.home, ".vector/bin/.vector-vector-native/receipt.tsv")).exists()).toBe(true)
  expect(
    (await readdir(path.join(instance.home, ".vector/bin"))).filter(
      (name) => name.endsWith(".lock") || name.startsWith(".vector-wsl."),
    ),
  ).toEqual([])
})

shellTest("failed legacy migration retains the old binary and refuses links or unrelated metadata", async () => {
  await using instance = await fixture()
  const native = path.join(instance.home, ".vector/bin/vector-native")
  const old = "#!/bin/sh\nprintf '1.0.0\\n'\n"
  await Bun.write(native, old)
  await chmod(native, 0o755)
  await instance.writeArchive("9.9.9")
  expect((await instance.run(wslInstallScript("1.16.2"))).code).toBe(1)
  expect(await Bun.file(native).text()).toBe(old)
  await instance.writeArchive()
  await mkdir(path.join(instance.home, ".vector/bin/.vector-vector-native"))
  await Bun.write(path.join(instance.home, ".vector/bin/.vector-vector-native/foreign"), "unrelated")
  expect((await instance.run(wslInstallScript("1.16.2"))).code).toBe(1)
  expect(await Bun.file(native).text()).toBe(old)
  await unlink(native)
  await symlink(path.join(instance.home, "archive/vector"), native)
  expect((await instance.run(wslInstallScript("1.16.2"))).stderr).toContain("linked WSL installation")
})

shellTest("a failed final rename rolls the dedicated legacy binary back", async () => {
  await using instance = await fixture()
  const native = path.join(instance.home, ".vector/bin/vector-native")
  const old = "#!/bin/sh\nprintf '1.0.0\\n'\n"
  await Bun.write(native, old)
  await chmod(native, 0o755)
  await unlink(path.join(instance.bin, "mv"))
  await Bun.write(
    path.join(instance.bin, "mv"),
    `#!/bin/sh\nif [ "$2" = "$HOME/.vector/bin/.vector-vector-native" ]; then exit 1; fi\nexec ${shellEscape(Bun.which("mv")!)} "$@"\n`,
  )
  await chmod(path.join(instance.bin, "mv"), 0o755)
  expect((await instance.run(wslInstallScript("1.16.2"))).code).toBe(1)
  expect(await Bun.file(native).text()).toBe(old)
  expect(await Bun.file(path.join(instance.home, ".vector/bin/.vector-vector-native/receipt.tsv")).exists()).toBe(false)
  expect(
    (await readdir(path.join(instance.home, ".vector/bin"))).filter(
      (name) => name.endsWith(".lock") || name.startsWith(".vector-wsl."),
    ),
  ).toEqual([])
})

shellTest("legacy migration respects the standalone installation lock", async () => {
  await using instance = await fixture()
  const native = path.join(instance.home, ".vector/bin/vector-native")
  const old = "#!/bin/sh\nprintf '1.0.0\\n'\n"
  await Bun.write(native, old)
  await chmod(native, 0o755)
  await mkdir(path.join(instance.home, ".vector/bin/.vector-vector-native.lock"))
  const result = await instance.run(wslInstallScript("1.16.2"))
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Another Vector installation")
  expect(await Bun.file(native).text()).toBe(old)
  expect(await readdir(path.join(instance.home, ".vector/bin"))).toEqual([
    ".vector-vector-native.lock",
    "vector-native",
  ])
})

shellTest("a failed rollback retains the old executable in the reported private backup", async () => {
  await using instance = await fixture()
  const native = path.join(instance.home, ".vector/bin/vector-native")
  const old = "#!/bin/sh\nprintf '1.0.0\\n'\n"
  await Bun.write(native, old)
  await chmod(native, 0o755)
  await unlink(path.join(instance.bin, "mv"))
  await Bun.write(
    path.join(instance.bin, "mv"),
    `#!/bin/sh\ncase "$1" in */previous) exit 1 ;; esac\nif [ "$2" = "$HOME/.vector/bin/.vector-vector-native" ]; then exit 1; fi\nexec ${shellEscape(Bun.which("mv")!)} "$@"\n`,
  )
  await chmod(path.join(instance.bin, "mv"), 0o755)
  const result = await instance.run(wslInstallScript("1.16.2"))
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Its backup remains at")
  const retained = (await readdir(path.join(instance.home, ".vector/bin"))).filter((name) =>
    name.startsWith(".vector-wsl."),
  )
  expect(retained).toHaveLength(1)
  expect(await Bun.file(path.join(instance.home, ".vector/bin", retained[0], "previous")).text()).toBe(old)
})

shellTest("the bootstrap rejects redirects before executing an installer", async () => {
  await using instance = await fixture()
  const curl = path.join(instance.bin, "curl")
  await Bun.write(curl, (await Bun.file(curl).text()).replace("then printf 200", "then printf 302"))
  const result = await instance.run(wslInstallScript("1.16.2"))
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("unexpected response or redirect")
  expect(await Bun.file(path.join(instance.home, "requests")).text()).toBe("https://vectordev.ai/install\n")
  expect(await Bun.file(path.join(instance.home, ".vector/bin/vector-native")).exists()).toBe(false)
})

for (const status of [200, 302, 401, 404, 500]) {
  test(`post-health authentication proof accepts only 401, received ${status}`, async () => {
    const requests: { path: string; authorization: string | null }[] = []
    using server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization") })
        return new Response(null, { status })
      },
    })
    let stopped = 0
    const check = requireWslAuthentication(
      server.url.href,
      "Debian",
      () => {
        stopped++
      },
      AbortSignal.timeout(1000),
    )
    if (status === 401) await expect(check).resolves.toBeUndefined()
    if (status !== 401) await expect(check).rejects.toThrow("not enforcing authentication")
    expect(stopped).toBe(status === 401 ? 0 : 1)
    expect(requests).toEqual([{ path: "/config", authorization: null }])
  })
}
