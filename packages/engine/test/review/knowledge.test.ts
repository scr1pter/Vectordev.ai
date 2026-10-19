import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { Effect } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { FSUtil } from "@vectordevai/core/fs-util"
import { buildReviewPrompt } from "@vectordevai/core/review/prompt"
import { Token } from "@vectordevai/core/util/token"
import { Instruction } from "../../src/session/instruction"
import { ReviewContext } from "../../src/review/context"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Vectorscope knows the specs: a review of a change gets the requirements and contracts the user's documents link to
// the changed files, with whether each link still holds, in at most 300 tokens, and nothing it may not see.

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, Ripgrep.node, Brain.node, BrainKnowledge.node, Instruction.node, FSUtil.node]),
  ),
)

const SPEC = `# Limits

## 1 Uploads

Uploads are limited to at most 50 MB per file by \`MAX_UPLOAD_BYTES\`.

## 2 Sessions

The \`refreshTokenTtl\` MUST be 14 days.
`

const setup = Effect.fn("test.setup")(function* (origin: BrainKnowledge.Origin, hold?: "web") {
  const dir = (yield* TestInstance).directory
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(path.join(dir, "src", "upload.ts"), "// Upload limits.\nexport const MAX_UPLOAD_BYTES = 64 * 1024 * 1024\n")
  yield* fs.writeWithDirs(
    path.join(dir, "src", "auth", "session.ts"),
    "export const refreshTokenTtl = (days: number) => days * 86_400\n",
  )
  const knowledge = yield* BrainKnowledge.Service
  const place = yield* (yield* Instruction.Service).place()
  const added = yield* knowledge.add(place, { type: "text", name: "Limits.md", text: SPEC, origin, ...(hold ? { hold } : {}) })
  if (added.type === "refused") throw new Error(added.message)
  yield* knowledge.wait(place, added.document.id, "searchable", 20_000)
  // The session code changes after it was linked.
  yield* Effect.promise(() => Bun.sleep(5))
  yield* fs.writeWithDirs(
    path.join(dir, "src", "auth", "session.ts"),
    "export const refreshTokenTtl = (hours: number) => hours * 3_600\n",
  )
  yield* knowledge.drift(place, { force: true })
  return { knowledge, place }
})

describe("ReviewContext.requirements", () => {
  it.instance(
    "the changed files' requirements come with their drift flags, within 300 tokens, and the prompt carries them as data",
    () =>
      Effect.gen(function* () {
        yield* setup("upload")
        const place = yield* (yield* Instruction.Service).place()
        const text = yield* ReviewContext.requirements({
          place,
          files: ["src/upload.ts", "src/auth/session.ts", "README.md"],
          personal: true,
        })
        expect(text).toBeDefined()
        expect(Token.estimate(text!)).toBeLessThanOrEqual(300)
        expect(text).toMatch(/\[r[0-9a-z]{12}\] constraint · Limits: Uploads are limited to at most 50 MB/)
        expect(text).toContain("→ src/upload.ts:2 (code says 64 MB)")
        expect(text).toMatch(/\[r[0-9a-z]{12}\] requirement · Limits: The refreshTokenTtl MUST be 14 days\./)
        expect(text).toContain("(drifted: the linked code changed since it was linked)")
        const prompt = buildReviewPrompt({
          mode: "full",
          trust: "trusted",
          base: "a".repeat(40),
          head: "b".repeat(40),
          diff: "diff --git a/src/upload.ts b/src/upload.ts",
          maxComments: 10,
          requirements: text!,
        })
        expect(prompt).toContain("<untrusted_linked_requirements>")
        expect(prompt).toContain("(code says 64 MB)")
        expect(prompt).toContain("cite its [id]")
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "a model that may train gets none of a private document, and a change to unlinked files gets nothing",
    () =>
      Effect.gen(function* () {
        yield* setup("upload")
        const place = yield* (yield* Instruction.Service).place()
        expect(
          yield* ReviewContext.requirements({ place, files: ["src/upload.ts"], personal: false }),
        ).toBeUndefined()
        expect(yield* ReviewContext.requirements({ place, files: ["README.md"], personal: true })).toBeUndefined()
        // Nothing to say, nothing in the prompt.
        const prompt = buildReviewPrompt({
          mode: "full",
          trust: "trusted",
          base: "a".repeat(40),
          head: "b".repeat(40),
          diff: "diff --git a/README.md b/README.md",
          maxComments: 10,
        })
        expect(prompt).not.toContain("linked_requirements")
      }),
    { git: true },
    60_000,
  )

  it.instance(
    "held content never reaches a review, and a forgotten document takes its links with it",
    () =>
      Effect.gen(function* () {
        const { knowledge } = yield* setup("agent", "web")
        const place = yield* (yield* Instruction.Service).place()
        const [document] = yield* knowledge.documents(place, { personal: true })
        expect(document!.status).toBe("held")
        const files = ["src/upload.ts", "src/auth/session.ts"]
        expect(yield* knowledge.links(place, "src/upload.ts", { personal: true })).not.toEqual([])
        expect(yield* ReviewContext.requirements({ place, files, personal: true })).toBeUndefined()
        yield* knowledge.update(place, document!.id, { action: "approve" })
        expect(yield* ReviewContext.requirements({ place, files, personal: true })).toBeDefined()
        yield* knowledge.remove(place, document!.id)
        expect(yield* ReviewContext.requirements({ place, files, personal: true })).toBeUndefined()
      }),
    { git: true },
    60_000,
  )
})
