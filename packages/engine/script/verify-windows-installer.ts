// Runs only in a disposable GitHub-hosted Windows runner: restores hosts and removes its exact fixture CA.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsRemoval } from "../src/installation/windows-remove"
import { WindowsPowerShell } from "../../core/src/util/windows-powershell"

if (
  process.platform !== "win32" ||
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.VECTOR_INSTALLER_WINDOWS_FIXTURE !== "1"
)
  throw new Error(
    "This fixture requires the disposable GitHub-hosted Windows CI job; it changes temporary certificate trust and hosts mappings.",
  )

const root = await mkdtemp(path.join(os.tmpdir(), "vector installer '"))
await using temporaryDirectory = {
  async [Symbol.asyncDispose]() {
    await rm(root, { recursive: true, force: true })
  },
}
const installer = path.resolve(import.meta.dir, "../../web/public/install.ps1")
const installDir = path.join(root, "installed with spaces")
const files = path.join(root, "archive")
await mkdir(files)
const powershell = path.join(process.env.SYSTEMROOT!, "System32/WindowsPowerShell/v1.0/powershell.exe")
const openssl = path.join(process.env.ProgramFiles!, "Git/usr/bin/openssl.exe")
const compiler = path.join(process.env.SYSTEMROOT!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe")
const hostsPath = path.join(process.env.SYSTEMROOT!, "System32/drivers/etc/hosts")
const originalHosts = await readFile(hostsPath)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const evidence: Record<string, boolean | number | string> = {}
const state = {
  version: "1.99.42",
  corrupt: false,
  redirect: false,
  stall: false,
  archive: new Uint8Array(),
  requests: [] as string[],
}

async function run(command: string[], env?: Record<string, string>) {
  const child = Bun.spawn(command, {
    env: WindowsPowerShell.environment(command[0], { ...process.env, ...env }),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}
const ps = (command: string) => run([powershell, "-NoProfile", "-NonInteractive", "-Command", command])
async function pack(version: string) {
  const source = path.join(root, "Fixture.cs")
  await writeFile(
    source,
    `using System; using System.Threading; class Fixture { static void Main(string[] args) { if(args.Length>0 && args[0]=="--version") Console.WriteLine("${version}"); else Thread.Sleep(900000); } }`,
  )
  const built = await run([compiler, "/nologo", "/target:exe", `/out:${path.join(files, "vector.exe")}`, source])
  assert.equal(built.code, 0, built.stderr + built.stdout)
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
    await writeFile(path.join(files, name), name)
  const zip = path.join(root, "archive.zip")
  const zipped = await ps(
    `Compress-Archive -LiteralPath ${["vector.exe", "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"].map((name) => quote(path.join(files, name))).join(",")} -DestinationPath ${quote(zip)} -Force`,
  )
  assert.equal(zipped.code, 0, zipped.stderr)
  state.archive = await Bun.file(zip).bytes()
  state.version = version
}
async function install(extra: string[] = []) {
  return await run(
    [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
      "-InstallDir",
      installDir,
      ...extra,
    ],
    {
      // Native installer prerequisites only; the fixture server is already running independently.
      PATH: [path.dirname(powershell), path.join(process.env.SYSTEMROOT!, "System32")].join(";"),
    },
  )
}
async function waitStatus(file: string, expected: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const status = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (status?.state === "failed") throw new Error(status.message)
    if (status?.state === expected) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${expected}`)
}

const certificate = path.join(root, "certificate.pem")
const key = path.join(root, "key.pem")
const administrator = await ps(
  "$ErrorActionPreference = 'Stop'; $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The disposable Windows installer fixture requires administrator access to LocalMachine Root.' }",
)
assert.equal(administrator.code, 0, administrator.stderr)
const generated = await run([
  openssl,
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  key,
  "-out",
  certificate,
  "-days",
  "1",
  "-subj",
  "/CN=Vector isolated installer fixture",
  "-addext",
  "subjectAltName=DNS:vectordev.ai,DNS:fixture.public.blob.vercel-storage.com",
])
assert.equal(generated.code, 0, generated.stderr)
const der = path.join(root, "certificate.cer")
assert.equal((await run([openssl, "x509", "-in", certificate, "-outform", "der", "-out", der])).code, 0)
const thumbprint = createHash("sha1")
  .update(await Bun.file(der).bytes())
  .digest("hex")
  .toUpperCase()
const certificatePath = `Cert:\\LocalMachine\\Root\\${thumbprint}`
const absent = await ps(
  `$ErrorActionPreference = 'Stop'; if (Test-Path -LiteralPath ${quote(certificatePath)}) { throw 'The fixture certificate already exists; refusing to take ownership.' }`,
)
assert.equal(absent.code, 0, absent.stderr)
// Register before import so partial failures still remove only this newly generated certificate.
await using trustedCertificate = {
  async [Symbol.asyncDispose]() {
    const removed = await ps(
      `$ErrorActionPreference = 'Stop'; if (Test-Path -LiteralPath ${quote(certificatePath)}) { Remove-Item -LiteralPath ${quote(certificatePath)} -ErrorAction Stop }; if (Test-Path -LiteralPath ${quote(certificatePath)}) { throw 'The fixture certificate was not removed.' }`,
    )
    assert.equal(removed.code, 0, removed.stderr)
  },
}
// CurrentUser Root can require UI even on CI; the disposable hosted runner is an administrator.
const trusted = await ps(
  `(Import-Certificate -FilePath ${quote(der)} -CertStoreLocation 'Cert:\\LocalMachine\\Root' -ErrorAction Stop).Thumbprint`,
)
assert.equal(trusted.code, 0, trusted.stderr)
assert.equal(trusted.stdout.trim().toUpperCase(), thumbprint)
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 443,
  idleTimeout: 0,
  tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  fetch(request) {
    const url = new URL(request.url)
    state.requests.push(url.pathname)
    if (state.redirect) return Response.redirect("https://unapproved.invalid/archive", 302)
    if (url.pathname === "/api/cli-release") {
      const target = url.searchParams.get("target")!
      const filename = `vector-${target}.zip`
      const pathname = `releases/vector-cli/v${state.version}/${filename}`
      return Response.json({
        version: state.version,
        target,
        filename,
        pathname,
        url: `https://fixture.public.blob.vercel-storage.com/${pathname}`,
        size: state.archive.length,
        sha256: state.corrupt ? "0".repeat(64) : createHash("sha256").update(state.archive).digest("hex"),
      })
    }
    if (state.stall)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(state.archive.slice(0, 1))
          },
        }),
        { headers: { "content-length": String(state.archive.length) } },
      )
    return new Response(state.archive)
  },
})
try {
  await writeFile(
    hostsPath,
    Buffer.concat([
      originalHosts,
      Buffer.from("\r\n127.0.0.1 vectordev.ai fixture.public.blob.vercel-storage.com # Vector isolated CI fixture\r\n"),
    ]),
  )
  await pack("1.99.42")
  const initial = await install(["-Version", "beta"])
  assert.equal(initial.code, 0, initial.stderr)
  const executable = path.join(installDir, "vector.exe")
  const first = await Bun.file(executable).bytes()
  const receipt = path.join(installDir, ".vector-vector.exe/receipt.tsv")
  assert.equal((await Bun.file(receipt).text()).split("\t")[4], "beta")
  evidence.nodeFreeInstall = true
  evidence.betaChannel = true
  state.corrupt = true
  assert.notEqual((await install()).code, 0)
  assert.deepEqual(await Bun.file(executable).bytes(), first)
  state.corrupt = false
  state.redirect = true
  assert.notEqual((await install()).code, 0)
  assert.deepEqual(await Bun.file(executable).bytes(), first)
  state.redirect = false
  evidence.checksumAndRedirectPreserveOld = true
  await pack("1.99.43")
  const abandoned = Bun.spawn([executable, "--hold"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  const abandonedIdentity = await ps(`(Get-Process -Id ${abandoned.pid}).StartTime.ToUniversalTime().Ticks.ToString()`)
  assert.equal(abandonedIdentity.code, 0, abandonedIdentity.stderr)
  const abandonedOperation = randomBytes(16).toString("hex")
  const abandonedStatus = path.join(installDir, `.vector-update-${abandonedOperation}.json`)
  const unacknowledged = install([
    "-Version",
    state.version,
    "-WaitForProcessId",
    String(abandoned.pid),
    "-WaitForStartTicks",
    abandonedIdentity.stdout.trim(),
    "-OperationId",
    abandonedOperation,
  ])
  try {
    await waitStatus(abandonedStatus, "prepared")
  } finally {
    abandoned.kill()
    await abandoned.exited
  }
  assert.notEqual((await unacknowledged).code, 0)
  assert.deepEqual(await Bun.file(executable).bytes(), first)
  evidence.unacknowledgedExitPreservesOld = true
  const holder = Bun.spawn([executable, "--hold"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  const identity = await ps(`(Get-Process -Id ${holder.pid}).StartTime.ToUniversalTime().Ticks.ToString()`)
  assert.equal(identity.code, 0, identity.stderr)
  const operation = randomBytes(16).toString("hex")
  const status = path.join(installDir, `.vector-update-${operation}.json`)
  const pending = install([
    "-Version",
    state.version,
    "-WaitForProcessId",
    String(holder.pid),
    "-WaitForStartTicks",
    identity.stdout.trim(),
    "-OperationId",
    operation,
  ])
  try {
    await waitStatus(status, "prepared")
    await writeFile(`${status}.ready`, "ready\n", { flag: "wx" })
    assert.deepEqual(
      await Bun.file(executable).bytes(),
      first,
      "A running executable must remain unchanged until it exits",
    )
  } finally {
    holder.kill()
    await holder.exited
  }
  const replaced = await pending
  assert.equal(replaced.code, 0, replaced.stderr)
  await waitStatus(status, "complete")
  assert.equal((await Bun.file(receipt).text()).split("\t")[2], "1.99.43")
  evidence.runningExecutableReplacement = true
  const current = await Bun.file(executable).bytes()
  state.stall = true
  const started = Date.now()
  const stalled = await install()
  assert.notEqual(stalled.code, 0)
  assert(Date.now() - started < 325_000, "Stalled body must terminate at the five-minute download deadline")
  assert(Date.now() - started >= 290_000, "The fixture must remain connected until the actual body deadline")
  assert.deepEqual(await Bun.file(executable).bytes(), current)
  evidence.stalledBodyMilliseconds = Date.now() - started
  evidence.stalledBodyPreservesOld = true
  const removalHolder = Bun.spawn([executable, "--hold"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  const removalIdentity = await ps(
    `(Get-Process -Id ${removalHolder.pid}).StartTime.ToUniversalTime().Ticks.ToString()`,
  )
  assert.equal(removalIdentity.code, 0, removalIdentity.stderr)
  const removalOperation = randomBytes(16).toString("hex")
  const removalStatus = path.join(installDir, `.vector-update-${removalOperation}.json`)
  const removalDirectory = path.join(installDir, `.vector-uninstall-${removalOperation}`)
  await mkdir(removalDirectory)
  const metadata = path.dirname(receipt)
  await writeFile(path.join(metadata, "keep-user-file"), "preserve")
  const removalScript = path.join(removalDirectory, "remove.ps1")
  await writeFile(
    removalScript,
    WindowsRemoval.script({
      pid: removalHolder.pid,
      startTicks: removalIdentity.stdout.trim(),
      executable,
      metadata,
      lock: path.join(installDir, ".vector-vector.exe.lock"),
      statusFile: removalStatus,
      temporaryDirectory: removalDirectory,
      binarySha256: createHash("sha256").update(current).digest("hex"),
      files: [
        executable,
        receipt,
        ...["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"].map((name) => path.join(metadata, name)),
      ],
    }),
  )
  const removing = run([
    powershell,
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    removalScript,
  ])
  try {
    await waitStatus(removalStatus, "prepared")
    await writeFile(`${removalStatus}.ready`, "ready\n", { flag: "wx" })
    assert.equal(await Bun.file(executable).exists(), true)
  } finally {
    removalHolder.kill()
    await removalHolder.exited
  }
  const removed = await removing
  assert.equal(removed.code, 0, removed.stderr)
  await waitStatus(removalStatus, "complete")
  assert.equal(await Bun.file(executable).exists(), false)
  assert.equal(await Bun.file(receipt).exists(), false)
  assert.equal(await Bun.file(path.join(metadata, "keep-user-file")).text(), "preserve")
  evidence.runningExecutableUninstall = true
} finally {
  server.stop(true)
  await writeFile(hostsPath, originalHosts)
  await Bun.write(path.resolve("vector-windows-installer-evidence.json"), JSON.stringify(evidence, null, 2))
}
console.log("Windows standalone installer acceptance passed", evidence)
