import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsPowerShell } from "../../src/installation/windows-powershell"

test("Windows PowerShell child environments discard inherited module paths without changing other variables", async () => {
  const inherited = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")),
    PSModulePath: "PowerShell 7 modules",
    psmodulepath: "differently cased inherited modules",
    VECTOR_INSTALLER_ENV_MARKER: "preserved",
    PATH: "preserved child PATH",
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `console.log(JSON.stringify({
        modules: Object.keys(process.env).filter(key => key.toUpperCase() === "PSMODULEPATH"),
        marker: process.env.VECTOR_INSTALLER_ENV_MARKER,
        path: process.env.PATH,
      }))`,
    ],
    {
      env: WindowsPowerShell.environment("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE", inherited),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ modules: [], marker: "preserved", path: "preserved child PATH" })
    expect(inherited.PSModulePath).toBe("PowerShell 7 modules")
    expect(inherited.psmodulepath).toBe("differently cased inherited modules")
  } finally {
    child.kill()
    await child.exited
  }
})

test("other commands retain their module paths", () => {
  const env = { PSModulePath: "user modules", PATH: "user path" }
  for (const command of ["pwsh.exe", "bun.exe", "npm", "C:\\tools\\custom-powershell.exe"])
    expect(WindowsPowerShell.environment(command, env)).toBe(env)
})

test.skipIf(process.platform !== "win32")(
  "pwsh to Bun to Windows PowerShell loads native certificate and installer commands",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vector powershell '"))
    const file = path.join(root, "hash fixture.txt")
    const entry = path.join(root, "child.ts")
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    try {
      await Bun.write(file, "installer hash fixture\n")
      await Bun.write(
        entry,
        `import assert from "node:assert/strict"
      import { WindowsPowerShell } from ${JSON.stringify(new URL("../../src/installation/windows-powershell.ts", import.meta.url).href)}
      assert.ok(process.env.PSModulePath, "pwsh must pass its module paths through Bun")
      const powershell = ${JSON.stringify(path.join(process.env.SYSTEMROOT!, "System32/WindowsPowerShell/v1.0/powershell.exe"))}
      const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-Command", ${JSON.stringify(
        `$ErrorActionPreference = 'Stop'; [pscustomobject]@{ Edition = $PSEdition; CertificateProvider = (Get-PSDrive Cert).Provider.Name; ProcessId = (Get-Process -Id $PID).Id; Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath ${quote(file)}).Hash; Marker = $env:VECTOR_INSTALLER_ENV_MARKER } | ConvertTo-Json -Compress`,
      )}], { env: WindowsPowerShell.environment(powershell), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      const timeout = setTimeout(() => child.kill(), 15_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        assert.equal(code, 0, stderr)
        console.log(stdout)
      } finally {
        clearTimeout(timeout)
        child.kill()
        await child.exited
      }`,
      )
      const child = Bun.spawn(
        [
          "pwsh.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `& ${quote(process.execPath)} --no-env-file ${quote(entry)}; exit $LASTEXITCODE`,
        ],
        {
          env: { ...process.env, VECTOR_INSTALLER_ENV_MARKER: "preserved" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const timeout = setTimeout(() => child.kill(), 20_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code, stderr).toBe(0)
        expect(JSON.parse(stdout)).toEqual({
          Edition: "Desktop",
          CertificateProvider: "Certificate",
          ProcessId: expect.any(Number),
          Hash: createHash("sha256").update("installer hash fixture\n").digest("hex").toUpperCase(),
          Marker: "preserved",
        })
      } finally {
        clearTimeout(timeout)
        child.kill()
        await child.exited
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
