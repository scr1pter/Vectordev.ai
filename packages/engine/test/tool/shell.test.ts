import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { describe, expect } from "bun:test"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Cause, Deferred, Effect, Exit, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type * as Scope from "effect/Scope"
import os from "os"
import path from "path"
import { Config } from "@/config/config"
import { Shell } from "@vectordevai/core/shell"
import { ShellTool } from "../../src/tool/shell"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Plugin } from "../../src/plugin"
import { testEffect } from "../lib/effect"
import { Tool } from "@/tool/tool"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"

const shellLayer = Layer.mergeAll(
  LayerNode.compile(
    LayerNode.group([
      CrossSpawnSpawner.node,
      FSUtil.node,
      Plugin.node,
      Truncate.node,
      Config.node,
      Agent.node,
      RuntimeFlags.node,
    ]),
  ),
  testInstanceStoreLayer,
)
const it = testEffect(shellLayer)
type ShellTestServices =
  | (typeof shellLayer extends Layer.Layer<infer ROut, infer _E, infer _RIn> ? ROut : never)
  | InstanceStore.Service
  | Scope.Scope

const initShell = Effect.fn("ShellToolTest.init")(function* () {
  const info = yield* ShellTool
  return yield* info.init()
})

const initBash = initShell

const run = Effect.fn("ShellToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const bash = yield* initShell()
  return yield* bash.execute(args, next)
})

const runIn = <A, E, R>(directory: string, self: Effect.Effect<A, E, R>) => self.pipe(provideInstance(directory))

const fail = Effect.fn("ShellToolTest.fail")(function* (
  args: Tool.InferParameters<typeof ShellTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* run(args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected command to fail")
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

Shell.acceptable.reset()
const quote = (text: string) => `"${text}"`
const squote = (text: string) => `'${text}'`
const projectRoot = path.join(__dirname, "../..")
const bin = quote(process.execPath.replaceAll("\\", "/"))
const bash = (() => {
  const shell = Shell.acceptable()
  if (Shell.name(shell) === "bash") return shell
  return Shell.gitbash()
})()
const shells = (() => {
  if (process.platform !== "win32") {
    const shell = Shell.acceptable()
    return [{ label: Shell.name(shell), shell }]
  }

  const list = [bash, Bun.which("pwsh"), Bun.which("powershell"), process.env.COMSPEC || Bun.which("cmd.exe")]
    .filter((shell): shell is string => Boolean(shell))
    .map((shell) => ({ label: Shell.name(shell), shell }))

  return list.filter(
    (item, i) => list.findIndex((other) => other.shell.toLowerCase() === item.shell.toLowerCase()) === i,
  )
})()
const PS = new Set(["pwsh", "powershell"])
const ps = shells.filter((item) => PS.has(item.label))
const cmdShell = shells.find((item) => item.label === "cmd")

const sh = () => Shell.name(Shell.acceptable())
const evalarg = (text: string) => (sh() === "cmd" ? quote(text) : squote(text))

const fill = (mode: "lines" | "bytes", n: number) => {
  const code =
    mode === "lines"
      ? "console.log(Array.from({length:Number(Bun.argv[1])},(_,i)=>i+1).join(String.fromCharCode(10)))"
      : "process.stdout.write(String.fromCharCode(97).repeat(Number(Bun.argv[1])))"
  const text = `${bin} -e ${evalarg(code)} ${n}`
  if (PS.has(sh())) return `& ${text}`
  return text
}
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

const forms = (dir: string) => {
  if (process.platform !== "win32") return [dir]
  const full = Filesystem.normalizePath(dir)
  const slash = full.replaceAll("\\", "/")
  const root = slash.replace(/^[A-Za-z]:/, "")
  return Array.from(new Set([full, slash, root, root.toLowerCase()]))
}

const withShell = <A, E, R>(item: { label: string; shell: string }, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = item.shell
      Shell.acceptable.reset()
      Shell.preferred.reset()
      return prev
    }),
    () => self,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
        Shell.preferred.reset()
      }),
  )

const each = (
  name: string,
  fn: (item: { label: string; shell: string }) => Effect.Effect<void, unknown, ShellTestServices>,
) => {
  for (const item of shells) {
    it.live(`${name} [${item.label}]`, () => withShell(item, fn(item)))
  }
}

const capture = (requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>, stop?: Error) => ({
  ...ctx,
  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      requests.push(req)
      if (stop) throw stop
    }),
})

const mustTruncate = (result: {
  metadata: { truncated?: boolean; exit?: number | null } & Record<string, unknown>
  output: string
}) => {
  if (result.metadata.truncated) return
  throw new Error(
    [`shell: ${process.env.SHELL || ""}`, `exit: ${String(result.metadata.exit)}`, "output:", result.output].join("\n"),
  )
}

describe("tool.shell", () => {
  each("basic", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: "echo test",
        })
        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output).toContain("test")
      }),
    ),
  )

  it.live("falls back from terminal-only configured shell", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ config: { shell: "fish" } })
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const bash = yield* initBash()
          const fallback = Shell.name(Shell.acceptable("fish"))
          expect(fallback).not.toBe("fish")
          expect(bash.description).toContain(fallback)

          const result = yield* bash.execute(
            {
              command: "echo fallback",
            },
            ctx,
          )
          expect(result.metadata.exit).toBe(0)
          expect(result.output).toContain("fallback")
        }),
      )
    }),
  )

  for (const scenario of [
    { mode: "exit", name: "drains final output after process exit while a metadata update is pending" },
    { mode: "abort", name: "aborts a pending metadata update after process exit without killing the closed process" },
    {
      mode: "timeout",
      name: "times out a pending metadata update after process exit without killing the closed process",
    },
    { mode: "failure", name: "preserves a metadata failure after process exit instead of reporting a timeout" },
    { mode: "early-failure", name: "fails and reaps a running process when its metadata consumer fails" },
  ] as const) {
    it.live(
      scenario.name,
      () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped({
            init: (directory) =>
              Effect.promise(() =>
                Bun.write(
                  path.join(directory, "drain-child.ts"),
                  `if (${scenario.mode === "early-failure"}) process.on("SIGTERM", () => { void Bun.write(".term-received", "received") })
await Bun.write(".child-pid", String(process.pid))
process.stdout.write("first chunk\\n")
while (!(await Bun.file(".metadata-ready").exists())) await Bun.sleep(5)
process.stderr.write("final chunk\\n")
if (${scenario.mode === "early-failure"}) while (true) await Bun.sleep(10)
`,
                ),
              ).pipe(Effect.asVoid),
          })
          const closed = yield* Deferred.make<void>()
          const controller = new AbortController()
          const metadataError = new Error("metadata update failed")
          const completed: string[] = []
          const killed: number[] = []
          const running: ChildProcessSpawner.ChildProcessHandle["isRunning"][] = []
          const outcome = yield* runIn(
            tmp,
            run(
              {
                command: `${scenario.mode === "early-failure" && process.platform !== "win32" ? "exec " : PS.has(sh()) ? "& " : ""}${bin} --no-env-file ./drain-child.ts`,
                timeout: 5_000,
              },
              {
                ...ctx,
                abort: controller.signal,
                metadata: (input) => {
                  const output = (input.metadata as { output?: string })?.output
                  if (!output?.includes("first chunk") || output.includes("final chunk")) return Effect.void
                  return Effect.gen(function* () {
                    yield* Effect.promise(() => Bun.write(path.join(tmp, ".metadata-ready"), "ready"))
                    if (scenario.mode === "early-failure") return yield* Effect.die(metadataError)
                    yield* Deferred.await(closed)
                    if (scenario.mode === "failure") return yield* Effect.die(metadataError)
                    if (scenario.mode === "abort") controller.abort()
                    if (scenario.mode !== "exit") return yield* Effect.never
                    // Simulate an output update still writing after the real process has closed.
                    yield* Effect.sleep("100 millis")
                    completed.push(output)
                  })
                },
              },
            ).pipe(
              Effect.updateService(ChildProcessSpawner.ChildProcessSpawner, (real) =>
                ChildProcessSpawner.make((command) =>
                  real.spawn(command).pipe(
                    Effect.map((handle) => {
                      running.push(handle.isRunning)
                      return ChildProcessSpawner.makeHandle({
                        ...handle,
                        exitCode: handle.exitCode.pipe(Effect.tap(() => Deferred.succeed(closed, undefined))),
                        kill: (options) => {
                          killed.push(handle.pid)
                          return handle.kill(options)
                        },
                      })
                    }),
                  ),
                ),
              ),
            ),
          ).pipe(Effect.exit)
          expect(yield* Deferred.isDone(closed)).toBe(scenario.mode !== "early-failure")
          expect(running).toHaveLength(1)
          expect(yield* running[0]).toBe(false)
          expect(killed).toHaveLength(scenario.mode === "early-failure" ? 1 : 0)
          if (scenario.mode === "early-failure" && process.platform !== "win32") {
            expect(Number(yield* Effect.promise(() => Bun.file(path.join(tmp, ".child-pid")).text()))).toBe(killed[0])
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp, ".term-received")).exists())).toBe(true)
          }
          if (scenario.mode === "failure" || scenario.mode === "early-failure") {
            expect(Exit.isFailure(outcome)).toBe(true)
            if (Exit.isFailure(outcome)) expect(Cause.squash(outcome.cause)).toBe(metadataError)
            return
          }
          const result = yield* outcome
          expect(result.output).toContain("first chunk")
          if (scenario.mode === "exit") {
            expect(result.metadata.exit).toBe(0)
            expect(result.output).toContain("final chunk")
            expect(completed).toHaveLength(1)
            return
          }
          expect(result.metadata.exit).toBeNull()
          expect(result.output).toContain(
            scenario.mode === "abort"
              ? "User aborted the command"
              : "shell tool terminated command after exceeding timeout 5000 ms",
          )
          expect(completed).toHaveLength(0)
        }),
      15_000,
    )
  }

  it.live("does not expose Vector's internal vault and bridge secrets to commands", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const values = {
          BLOB_READ_WRITE_TOKEN: "release-store-secret",
          VECTOR_AUTH_CONTENT: "aggregate-secret",
          VECTOR_CONSOLE_TOKEN: "console-secret",
          VECTOR_SERVER_PASSWORD: "server-secret",
          VECTOR_CLOUD_TOKEN: "cloud-secret",
          VECTOR_CREDENTIAL_KEY: "vault-secret",
          VECTOR_INSTALLER_BLOB_TOKEN: "installer-secret",
          VECTOR_MCP_AUTH_KEY: "mcp-secret",
          OPENAI_API_KEY: "provider-secret",
        }
        const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
        Object.assign(process.env, values)
        return previous
      }),
      () =>
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const code = `process.stdout.write(JSON.stringify({
              blob: process.env.BLOB_READ_WRITE_TOKEN,
              aggregate: process.env.VECTOR_AUTH_CONTENT,
              console: process.env.VECTOR_CONSOLE_TOKEN,
              password: process.env.VECTOR_SERVER_PASSWORD,
              cloud: process.env.VECTOR_CLOUD_TOKEN,
              vault: process.env.VECTOR_CREDENTIAL_KEY,
              installer: process.env.VECTOR_INSTALLER_BLOB_TOKEN,
              mcp: process.env.VECTOR_MCP_AUTH_KEY,
              provider: process.env.OPENAI_API_KEY,
            }))`
            const command = `${PS.has(sh()) ? "& " : ""}${bin} -e ${evalarg(code)}`
            const result = yield* run({ command })
            expect(result.output).toContain('"provider":"provider-secret"')
            ;[
              "release-store-secret",
              "aggregate-secret",
              "console-secret",
              "server-secret",
              "cloud-secret",
              "vault-secret",
              "installer-secret",
              "mcp-secret",
            ].forEach((secret) => expect(result.output).not.toContain(secret))
          }),
        ),
      (previous) =>
        Effect.sync(() => {
          Object.entries(previous).forEach(([key, value]) => {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          })
        }),
    ),
  )
})

describe("tool.shell permissions", () => {
  each("asks for bash permission with correct pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo hello",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo hello")
        }),
      )
    }),
  )

  each("asks for bash permission with multiple commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "echo foo && echo bar",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("bash")
          expect(requests[0].patterns).toContain("echo foo")
          expect(requests[0].patterns).toContain("echo bar")
        }),
      )
    }),
  )

  for (const item of ps) {
    it.live(`parses PowerShell conditionals for permission prompts [${item.label}]`, () =>
      withShell(
        item,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: "Write-Host foo; if ($?) { Write-Host bar }",
              },
              capture(requests),
            )
            const bashReq = requests.find((r) => r.permission === "bash")
            expect(bashReq).toBeDefined()
            expect(bashReq!.patterns).toContain("Write-Host foo")
            expect(bashReq!.patterns).toContain("Write-Host bar")
            expect(bashReq!.always).toContain("Write-Host *")
          }),
        ),
      ),
    )
  }

  for (const item of ps) {
    it.live(`uses PowerShell cmdlet prefixes for always-allow prompts [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Remove-Item -Recurse tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.always).toContain("Remove-Item *")
              expect(bashReq!.always).not.toContain("Remove-Item -Recurse *")
            }),
          )
        }),
      ),
    )
  }

  each("asks for edit permission for the files a redirect writes", () =>
    Effect.gen(function* () {
      const outside = yield* tmpdirScoped()
      yield* runIn(
        projectRoot,
        Effect.gen(function* () {
          const err = new Error("stop before running")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const target = path.join(outside, "notes.txt").replaceAll("\\", "/")
          yield* fail(
            { command: `git status > zz-redirect.txt 2>&1 >> "${target}"` },
            {
              ...ctx,
              ask: (req) =>
                Effect.sync(() => {
                  requests.push(req)
                  if (req.permission === "bash") throw err
                }),
            },
          )
          const edit = requests.find((r) => r.permission === "edit")
          expect(edit?.patterns).toHaveLength(2)
          expect(edit?.patterns.some((item) => item.replaceAll("\\", "/").endsWith("engine/zz-redirect.txt"))).toBe(
            true,
          )
          expect(requests.find((r) => r.permission === "external_directory")?.patterns).toContain(
            glob(path.join(outside, "*")),
          )
          // Descriptor merges and the null device write no file.
          requests.length = 0
          yield* fail({ command: "git status 2>&1 > /dev/null" }, capture(requests, err))
          expect(requests.map((r) => r.permission)).toEqual(["bash"])
        }),
      )
    }),
  )

  each("asks for external_directory permission for wildcard external paths", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
        const file = process.platform === "win32" ? `${process.env.WINDIR!.replaceAll("\\", "/")}/*` : "/etc/*"
        const want = process.platform === "win32" ? glob(path.join(process.env.WINDIR!, "*")) : "/etc/*"
        expect(
          yield* fail(
            {
              command: `cat ${file}`,
            },
            capture(requests, err),
          ),
        ).toMatchObject({ message: err.message })
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns).toContain(want)
      }),
    ),
  )

  if (process.platform === "win32") {
    if (bash) {
      it.live("asks for nested bash command permissions [bash]", () =>
        withShell(
          { label: "bash", shell: bash },
          Effect.gen(function* () {
            const outerTmp = yield* tmpdirScoped()
            yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
            yield* runIn(
              projectRoot,
              Effect.gen(function* () {
                const file = path.join(outerTmp, "outside.txt").replaceAll("\\", "/")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                yield* run(
                  {
                    command: `echo $(cat "${file}")`,
                  },
                  capture(requests),
                )
                const extDirReq = requests.find((r) => r.permission === "external_directory")
                const bashReq = requests.find((r) => r.permission === "bash")
                expect(extDirReq).toBeDefined()
                expect(extDirReq!.patterns).toContain(glob(path.join(outerTmp, "*")))
                expect(bashReq).toBeDefined()
                expect(bashReq!.patterns).toContain(`cat "${file}"`)
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell paths after switches [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Copy-Item -PassThru "${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini" ./out`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for nested PowerShell command permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const file = `${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`
              yield* run(
                {
                  command: `Write-Output $(Get-Content ${file})`,
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).toContain(`Get-Content ${file}`)
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for drive-relative PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "C:../outside.txt"',
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $HOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$HOME/.ssh/config"',
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(os.homedir(), ".ssh", "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PWD PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const err = new Error("stop after permission")
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(
                  yield* fail(
                    {
                      command: 'Get-Content "$PWD/../outside.txt"',
                    },
                    capture(requests, err),
                  ),
                ).toMatchObject({ message: err.message })
                expect(requests[0]?.permission).toBe("external_directory")
                if (requests[0]?.permission !== "external_directory") return
                expect(requests[0].patterns).toContain(glob(path.join(path.dirname(tmp), "*")))
              }),
            )
          }),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for $PSHOME PowerShell paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: 'Get-Content "$PSHOME/outside.txt"',
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(glob(path.join(path.dirname(item.shell), "*")))
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for missing PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const key = "VECTOR_TEST_MISSING"
              const prev = process.env[key]
              delete process.env[key]
              return { key, prev }
            }),
            ({ key }) =>
              runIn(
                projectRoot,
                Effect.gen(function* () {
                  const err = new Error("stop after permission")
                  const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                  const root = path.parse(process.env.WINDIR!).root.replace(/[\\/]+$/, "")
                  expect(
                    yield* fail(
                      {
                        command: `Get-Content -Path "${root}$env:${key}\\Windows\\win.ini"`,
                      },
                      capture(requests, err),
                    ),
                  ).toMatchObject({ message: err.message })
                  const extDirReq = requests.find((r) => r.permission === "external_directory")
                  expect(extDirReq).toBeDefined()
                  expect(extDirReq!.patterns).toContain(glob(path.join(process.env.WINDIR!, "*")))
                }),
              ),
            ({ key, prev }) =>
              Effect.sync(() => {
                if (prev === undefined) delete process.env[key]
                else process.env[key] = prev
              }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Get-Content $env:WINDIR/win.ini",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for PowerShell FileSystem paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: `Get-Content -Path FileSystem::${process.env.WINDIR!.replaceAll("\\", "/")}/win.ini`,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`asks for external_directory permission for braced PowerShell env paths [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "Get-Content ${env:WINDIR}/win.ini",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]?.permission).toBe("external_directory")
              if (requests[0]?.permission !== "external_directory") return
              expect(requests[0].patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`treats Set-Location like cd for permissions [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Set-Location C:/Windows",
                },
                capture(requests),
              )
              const extDirReq = requests.find((r) => r.permission === "external_directory")
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(extDirReq).toBeDefined()
              expect(extDirReq!.patterns).toContain(
                Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")),
              )
              expect(bashReq).toBeUndefined()
            }),
          ),
        ),
      )
    }

    for (const item of ps) {
      it.live(`does not add nested PowerShell expressions to permission prompts [${item.label}]`, () =>
        withShell(
          item,
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              yield* run(
                {
                  command: "Write-Output ('a' * 3)",
                },
                capture(requests),
              )
              const bashReq = requests.find((r) => r.permission === "bash")
              expect(bashReq).toBeDefined()
              expect(bashReq!.patterns).not.toContain("a * 3")
              expect(bashReq!.always).not.toContain("a *")
            }),
          ),
        ),
      )
    }
  }

  if (process.platform === "win32" && cmdShell) {
    it.live("asks for external_directory permission for cmd file commands [cmd]", () =>
      withShell(
        cmdShell,
        runIn(
          projectRoot,
          Effect.gen(function* () {
            const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
            yield* run(
              {
                command: `TYPE "${path.join(process.env.WINDIR!, "win.ini")}"`,
              },
              capture(requests),
            )
            const extDirReq = requests.find((r) => r.permission === "external_directory")
            expect(extDirReq).toBeDefined()
            expect(extDirReq!.patterns).toContain(Filesystem.normalizePathPattern(path.join(process.env.WINDIR!, "*")))
          }),
        ),
      ),
    )
  }

  each("asks for external_directory permission when cd to parent", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "cd ../",
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
        }),
      )
    }),
  )

  each("asks for external_directory permission when workdir is outside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          expect(
            yield* fail(
              {
                command: "echo ok",
                workdir: os.tmpdir(),
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(glob(path.join(os.tmpdir(), "*")))
        }),
      )
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes external_directory workdir variants on Windows", () =>
      Effect.gen(function* () {
        const err = new Error("stop after permission")
        const outerTmp = yield* tmpdirScoped()
        const tmp = yield* tmpdirScoped()
        yield* runIn(
          tmp,
          Effect.gen(function* () {
            const want = Filesystem.normalizePathPattern(path.join(outerTmp, "*"))

            for (const dir of forms(outerTmp)) {
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: dir,
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })

              const extDirReq = requests.find((r) => r.permission === "external_directory")
              expect({ dir, patterns: extDirReq?.patterns, always: extDirReq?.always }).toEqual({
                dir,
                patterns: [want],
                always: [want],
              })
            }
          }),
        )
      }),
    )

    if (bash) {
      it.live("uses Git Bash /tmp semantics for external workdir", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "echo ok",
                    workdir: "/tmp",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )

      it.live("uses Git Bash /tmp semantics for external file paths", () =>
        withShell(
          { label: "bash", shell: bash },
          runIn(
            projectRoot,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              const want = glob(path.join(os.tmpdir(), "*"))
              expect(
                yield* fail(
                  {
                    command: "cat /tmp/vector-does-not-exist",
                  },
                  capture(requests, err),
                ),
              ).toMatchObject({ message: err.message })
              expect(requests[0]).toMatchObject({
                permission: "external_directory",
                patterns: [want],
                always: [want],
              })
            }),
          ),
        ),
      )
    }
  }

  each("asks for external_directory permission when file arg is outside project", () =>
    Effect.gen(function* () {
      const outerTmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const filepath = path.join(outerTmp, "outside.txt")
          expect(
            yield* fail(
              {
                command: `cat ${filepath}`,
              },
              capture(requests, err),
            ),
          ).toMatchObject({ message: err.message })
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(extDirReq).toBeDefined()
          expect(extDirReq!.patterns).toContain(expected)
          expect(extDirReq!.always).toContain(expected)
          expect(extDirReq!.metadata).toMatchObject({
            command: `cat ${filepath}`,
            directories: [outerTmp],
            patterns: [expected],
          })
        }),
      )
    }),
  )

  each("does not ask for external_directory permission when rm inside project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => Bun.write(path.join(tmp, "tmpfile"), "x"))
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: `rm -rf ${path.join(tmp, "nested")}`,
            },
            capture(requests),
          )
          const extDirReq = requests.find((r) => r.permission === "external_directory")
          expect(extDirReq).toBeUndefined()
        }),
      )
    }),
  )

  each("includes always patterns for auto-approval", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "git log --oneline -5",
            },
            capture(requests),
          )
          expect(requests.length).toBe(1)
          expect(requests[0].always.length).toBeGreaterThan(0)
          expect(requests[0].always.some((item) => item.endsWith("*"))).toBe(true)
        }),
      )
    }),
  )

  each("does not ask for bash permission when command is cd only", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run(
            {
              command: "cd .",
            },
            capture(requests),
          )
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeUndefined()
        }),
      )
    }),
  )

  each("matches redirects in permission pattern", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const err = new Error("stop after permission")
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          const stopAtBash = {
            ...ctx,
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => {
                requests.push(req)
                if (req.permission === "bash") throw err
              }),
          }
          expect(yield* fail({ command: "echo test > output.txt" }, stopAtBash)).toMatchObject({
            message: err.message,
          })
          expect(requests.map((r) => r.permission)).toEqual(["edit", "bash"])
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq!.patterns).toContain("echo test > output.txt")
        }),
      )
    }),
  )

  each("always pattern has space before wildcard to not include different commands", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* runIn(
        tmp,
        Effect.gen(function* () {
          const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
          yield* run({ command: "ls -la" }, capture(requests))
          const bashReq = requests.find((r) => r.permission === "bash")
          expect(bashReq).toBeDefined()
          expect(bashReq!.always[0]).toBe("ls *")
        }),
      )
    }),
  )
})

describe("tool.shell read-only allowlist", () => {
  // Shaped like agent.ts's readonlyVerificationBash, the rules the review,
  // judge, explore and security agents run under.
  const readonly = Permission.fromConfig({
    bash: {
      "*": "deny",
      "git diff*": "allow",
      "git status*": "allow",
      "git show*": "allow",
      "git log*": "allow",
    },
  })

  // Decides a request the way Permission.ask does: one denied pattern denies
  // the whole command.
  const enforce = (requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">>) => ({
    ...ctx,
    ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
      Effect.sync(() => {
        requests.push(req)
        const rules = req.patterns.map((pattern) => Permission.evaluate(req.permission, pattern, readonly))
        if (rules.some((rule) => rule.action === "deny")) throw new PermissionV1.DeniedError({ ruleset: readonly })
        if (rules.some((rule) => rule.action === "ask")) throw new Error(`unexpected prompt: ${req.patterns}`)
      }),
  })

  // [command, the pattern that must be checked for it]
  const denied = [
    ["export GIT_EXTERNAL_DIFF=/bin/sh; git diff", "export GIT_EXTERNAL_DIFF=/bin/sh"],
    ["declare -x X=1; git status", "declare -x X=1"],
    ["readonly X=1", "readonly X=1"],
    ["unset X", "unset X"],
    ["X=1; git status", "X=1"],
    ["f() { rm -rf x; }; git diff", "f() { rm -rf x; }"],
    ["A=1 git diff", "A=1 git diff"],
  ]

  // PowerShell parses these as different statements.
  for (const item of shells.filter((item) => !PS.has(item.label))) {
    for (const [command, pattern] of denied) {
      it.live(`denies ${command} [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                expect(yield* fail({ command }, enforce(requests))).toBeInstanceOf(PermissionV1.DeniedError)
                expect(requests.find((r) => r.permission === "bash")?.patterns).toContain(pattern)
              }),
            )
          }),
        ),
      )
    }

    for (const command of ["git diff main", "git log -5"]) {
      it.live(`allows ${command} [${item.label}]`, () =>
        withShell(
          item,
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped({ git: true })
            yield* runIn(
              tmp,
              Effect.gen(function* () {
                const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
                const result = yield* run({ command }, enforce(requests))
                expect(requests.map((r) => r.patterns)).toEqual([[command]])
                expect(result.metadata.exit).toEqual(expect.any(Number))
              }),
            )
          }),
        ),
      )
    }

    it.live(`always-allow covers only the exact statement [${item.label}]`, () =>
      withShell(
        item,
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* runIn(
            tmp,
            Effect.gen(function* () {
              const err = new Error("stop after permission")
              const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
              expect(yield* fail({ command: "export X=1; git status" }, capture(requests, err))).toMatchObject({
                message: err.message,
              })
              expect(requests[0]?.always).toContain("export X=1")
              expect(requests[0]?.always).toContain("git status *")
              expect(requests[0]?.always).not.toContain("export *")
            }),
          )
        }),
      ),
    )
  }
})

describe("tool.shell abort", () => {
  it.live(
    "preserves output when aborted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const controller = new AbortController()
          const collected: string[] = []
          const res = yield* run(
            {
              command: `echo before && sleep 30`,
            },
            {
              ...ctx,
              abort: controller.signal,
              metadata: (input) =>
                Effect.sync(() => {
                  const output = (input.metadata as { output?: string })?.output
                  if (output && output.includes("before") && !controller.signal.aborted) {
                    collected.push(output)
                    controller.abort()
                  }
                }),
            },
          )
          expect(res.output).toContain("before")
          expect(res.output).toContain("User aborted the command")
          expect(collected.length).toBeGreaterThan(0)
        }),
      ),
    15_000,
  )

  it.live(
    "terminates command on timeout",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `sleep 60`,
            timeout: 500,
          })
          expect(result.output).toContain("shell tool terminated command after exceeding timeout")
          expect(result.output).toContain("retry with a larger timeout value in milliseconds")
        }),
      ),
    15_000,
  )

  it.live(
    "uses RuntimeFlags bashDefaultTimeoutMs when timeout is omitted",
    () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const tool = yield* initShell()
          expect(tool.description).toContain("commands will time out after 500ms")
          const result = yield* tool.execute(
            {
              command: `sleep 60`,
            },
            ctx,
          )
          expect(result.output).toContain("exceeding timeout 500 ms")
        }),
      ).pipe(Effect.provide(RuntimeFlags.layer({ bashDefaultTimeoutMs: 500 }))),
    15_000,
  )

  if (process.platform !== "win32") {
    it.live("captures stderr in output", () =>
      runIn(
        projectRoot,
        Effect.gen(function* () {
          const result = yield* run({
            command: `echo stdout_msg && echo stderr_msg >&2`,
          })
          expect(result.output).toContain("stdout_msg")
          expect(result.output).toContain("stderr_msg")
          expect(result.metadata.exit).toBe(0)
        }),
      ),
    )
  }

  it.live("returns non-zero exit code", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: `exit 42`,
        })
        expect(result.metadata.exit).toBe(42)
      }),
    ),
  )

  it.live("streams metadata updates progressively", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const updates: string[] = []
        const result = yield* run(
          {
            command: `echo first && sleep 0.1 && echo second`,
          },
          {
            ...ctx,
            metadata: (input) =>
              Effect.sync(() => {
                const output = (input.metadata as { output?: string })?.output
                if (output) updates.push(output)
              }),
          },
        )
        expect(result.output).toContain("first")
        expect(result.output).toContain("second")
        expect(updates.length).toBeGreaterThan(1)
      }),
    ),
  )
})

describe("tool.shell truncation", () => {
  it.live("truncates output exceeding line limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 500
        const result = yield* run({
          command: fill("lines", lineCount),
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("keeps the start and the end of long output within a 30KB budget", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        // 12,000 numbered lines is about 64KB: past the 30KB shell budget, under the generic line cap.
        const result = yield* run({ command: fill("lines", 12_000) })
        mustTruncate(result)
        const lines = result.output.split("\n")
        // A build prints the failing step early and the summary late, so both ends survive.
        expect(lines).toContain("1")
        expect(lines).toContain("12000")
        expect(result.output).toMatch(/\.\.\.\d+ bytes omitted\.\.\./)
        expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThan(31_000 + 500)
      }),
    ),
  )

  it.live("truncates output exceeding byte limit", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const byteCount = Truncate.MAX_BYTES + 10000
        const result = yield* run({
          command: fill("bytes", byteCount),
        })
        mustTruncate(result)
        expect(result.output).toMatch(/\.\.\.output truncated\.\.\./)
        expect(result.output).toMatch(/Full output saved to:\s+\S+/)
      }),
    ),
  )

  it.live("does not truncate small output", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const result = yield* run({
          command: fill("lines", 1),
        })
        expect((result.metadata as { truncated?: boolean }).truncated).toBe(false)
        expect(result.output).toContain("1")
      }),
    ),
  )

  it.live("full output is saved to file when truncated", () =>
    runIn(
      projectRoot,
      Effect.gen(function* () {
        const lineCount = Truncate.MAX_LINES + 100
        const result = yield* run({
          command: fill("lines", lineCount),
        })
        mustTruncate(result)

        const filepath = (result.metadata as { outputPath?: string }).outputPath
        expect(filepath).toBeTruthy()

        const saved = yield* (yield* FSUtil.Service).readFileString(filepath!)
        const lines = saved.trim().split(/\r?\n/)
        expect(lines.length).toBe(lineCount)
        expect(lines[0]).toBe("1")
        expect(lines[lineCount - 1]).toBe(String(lineCount))
      }),
    ),
  )
})
