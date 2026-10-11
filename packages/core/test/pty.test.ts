import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@vectordevai/core/config"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Location } from "@vectordevai/core/location"
import { Pty } from "@vectordevai/core/pty"
import { AbsolutePath } from "@vectordevai/core/schema"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

let entries: Config.Entry[] = []
let executable = false
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [
      Config.node,
      Layer.mock(Config.Service)({
        entries: () => Effect.succeed(entries),
        executable: () => executable,
      }),
    ],
    [
      Location.node,
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) }))),
    ],
  ]),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live

describe("pty workspace trust", () => {
  ptyTest("does not execute an untrusted project-selected shell", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const shell = path.join(tmp.path, "project-shell")
          const marker = path.join(tmp.path, "executed")
          yield* Effect.promise(() =>
            fs.writeFile(shell, `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nexec /bin/sh "$@"\n`),
          )
          yield* Effect.promise(() => fs.chmod(shell, 0o700))
          entries = [
            new Config.Document({
              type: "document",
              path: path.join(tmp.path, "vector.json"),
              info: new Config.Info({ shell: "./project-shell" }),
            }),
          ]

          const pty = yield* Pty.Service
          const info = yield* Effect.acquireRelease(pty.create({ title: "untrusted" }), (created) =>
            pty.remove(created.id).pipe(Effect.ignore),
          )
          yield* Effect.promise(() => Bun.sleep(100))

          expect(info.command).not.toBe(shell)
          expect(yield* Effect.promise(() => fs.stat(marker).catch(() => undefined))).toBeUndefined()
        }),
      (tmp) =>
        Effect.sync(() => {
          entries = []
          executable = false
        }).pipe(Effect.andThen(Effect.promise(() => tmp[Symbol.asyncDispose]()))),
    ),
  )

  ptyTest("resolves an approved relative shell to its canonical config-relative target", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const target = path.join(tmp.path, "shell-target")
          const shell = path.join(tmp.path, "project-shell")
          yield* Effect.promise(() => fs.writeFile(target, '#!/bin/sh\nexec /bin/sh "$@"\n'))
          yield* Effect.promise(() => fs.chmod(target, 0o700))
          yield* Effect.promise(() => fs.symlink(target, shell))
          executable = true
          entries = [
            new Config.Document({
              type: "document",
              path: path.join(tmp.path, "vector.json"),
              info: new Config.Info({ shell: "./project-shell" }),
            }),
          ]

          const pty = yield* Pty.Service
          const info = yield* Effect.acquireRelease(pty.create({ title: "trusted" }), (created) =>
            pty.remove(created.id).pipe(Effect.ignore),
          )

          expect(info.command).toBe(target)
        }),
      (tmp) =>
        Effect.sync(() => {
          entries = []
          executable = false
        }).pipe(Effect.andThen(Effect.promise(() => tmp[Symbol.asyncDispose]()))),
    ),
  )
})
