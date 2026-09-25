import { expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm, symlink, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { wslInstallScript, wslNpmProbeScript, wslResolveScript, wslServerScript } from "./scripts"
import { requireWslAuthentication } from "./startup"

// The generated Linux scripts run on Unix CI; Windows runs the controller tests.
const shellTest = process.platform === "win32" ? test.skip : test

async function fixture(manager: "nvm" | "fnm" | "none", arch = "x64", version = "1.16.2") {
  const home = await mkdtemp(path.join(os.tmpdir(), "vector-wsl-"))
  const bin = path.join(home, "tools")
  const tools = path.join(home, "manager/bin")
  await mkdir(bin, { recursive: true })
  await mkdir(tools, { recursive: true })
  for (const command of ["awk", "sed", "mkdir", "install", "mv", "rm", "cp"]) {
    const executable = Bun.which(command)
    if (!executable) throw new Error(`Missing test utility: ${command}`)
    await symlink(executable, path.join(bin, command))
  }
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required to exercise npm package resolution")
  await symlink(node, path.join(tools, "node"))
  await Bun.write(path.join(bin, "uname"), `#!/bin/sh\nprintf '%s\\n' ${arch === "x64" ? "x86_64" : "aarch64"}\n`)
  await chmod(path.join(bin, "uname"), 0o755)
  await Bun.write(
    path.join(home, "fixture-native"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi
printf '%s\\n' "$VECTOR_CLI" "$VECTOR_SERVER_PASSWORD" "$WSLENV" "$PATH" "$@"
`,
  )
  await chmod(path.join(home, "fixture-native"), 0o755)
  await Bun.write(
    path.join(tools, "npm"),
    `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/npm-args"
root="$HOME/.vector/lib/node_modules/@vectordevai/cli/node_modules/@vectordevai/cli-linux-${arch}"
mkdir -p "$root/bin"
printf '%s\\n' '{"name":"@vectordevai/cli-linux-${arch}","version":"${version}"}' > "$root/package.json"
cp "$HOME/fixture-native" "$root/bin/vector"
`,
  )
  await chmod(path.join(tools, "npm"), 0o755)
  if (manager === "nvm") {
    await Bun.write(path.join(home, ".nvm/nvm.sh"), 'export PATH="$HOME/manager/bin:$PATH"\n')
  }
  if (manager === "fnm") {
    await Bun.write(
      path.join(home, ".local/share/fnm/fnm"),
      `#!/bin/sh
if [ "$1" = env ]; then printf '%s\\n' 'export PATH="$HOME/manager/bin:$PATH"'; fi
`,
    )
    await chmod(path.join(home, ".local/share/fnm/fnm"), 0o755)
  }
  return {
    home,
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

for (const manager of ["nvm", "fnm"] as const) {
  for (const arch of ["x64", "arm64"]) {
    shellTest(`${manager} ${arch}: installs the exact native package and runs without Node`, async () => {
      await using instance = await fixture(manager, arch)
      expect(await instance.run(wslNpmProbeScript())).toMatchObject({ code: 0, stdout: "yes" })
      expect(await instance.run(wslInstallScript("1.16.2"))).toMatchObject({ code: 0, stderr: "" })
      expect(await Bun.file(path.join(instance.home, "npm-args")).text()).toBe(
        `install\n--global\n--prefix\n${instance.home}/.vector\n@vectordevai/cli@1.16.2\n`,
      )
      await unlink(path.join(instance.home, "manager/bin/node"))
      const resolved = await instance.run(wslResolveScript())
      expect(resolved.stdout.trim()).toBe(path.join(instance.home, ".vector/bin/vector-native"))
      const result = await instance.run(
        wslServerScript({
          binary: resolved.stdout.trim(),
          port: 4123,
          logLevel: "WARN",
          env: { VECTOR_SERVER_PASSWORD: "fixture'password", VECTOR_SERVER_USERNAME: "vector" },
        }),
      )
      expect(result.code).toBe(0)
      expect(result.stdout.split("\n").slice(0, 3)).toEqual(["1", "fixture'password", ""])
      expect(result.stdout).not.toContain("/mnt/c/")
      expect(result.stdout).toContain("serve\n--hostname\n127.0.0.1\n--port\n4123\n")
    })
  }
}

shellTest("a distro without npm fails readiness and explains installation prerequisites", async () => {
  await using instance = await fixture("none")
  expect(await instance.run(wslNpmProbeScript())).toMatchObject({ code: 0, stdout: "no" })
  expect(await instance.run(wslInstallScript("1.16.2"))).toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Install Node.js and npm"),
  })
  expect(await Bun.file(path.join(instance.home, "npm-args")).exists()).toBe(false)
})

shellTest("a mismatched native package cannot replace a working installation", async () => {
  await using instance = await fixture("nvm", "x64", "1.16.1")
  const native = path.join(instance.home, ".vector/bin/vector-native")
  await Bun.write(native, "previous-native")
  expect(await instance.run(wslInstallScript("1.16.2"))).toMatchObject({
    code: 1,
    stderr: expect.stringContaining("does not match 1.16.2"),
  })
  expect(await Bun.file(native).text()).toBe("previous-native")
})

shellTest("a Node launcher alone requires reinstalling the native WSL executable", async () => {
  await using instance = await fixture("none")
  const launcher = path.join(instance.home, ".vector/bin/vector")
  await Bun.write(launcher, "#!/usr/bin/env node\n")
  await chmod(launcher, 0o755)
  expect(await instance.run(wslResolveScript())).toMatchObject({ code: 0, stdout: "" })
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
