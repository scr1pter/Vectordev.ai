import { describe, expect, test } from "bun:test"
import { buildModelSections, pickerModelKey } from "@/utils/provider-brand"
import {
  EXTERNAL_RUNTIME_MODELS,
  externalRuntimeModelName,
  externalRuntimeModels,
  externalRuntimeModelState,
  forgetRefusedRuntimeModel,
  launchRuntimeModel,
  rememberRuntimeModel,
  RUNTIME_DEFAULT_MODEL,
} from "./external-runtime-models"
import type { ExternalRuntime } from "./external-runtimes"

const runtimes: ExternalRuntime[] = ["claude-code", "codex", "cursor"]

// What the composer's picker shows: the same sections the popover builds, with a fixed catalog keeping its order.
function sections(runtime: ExternalRuntime, current?: string, recent: string[] = []) {
  const models = externalRuntimeModels(runtime, current)
  const key = (id: string) => pickerModelKey(models.find((model) => model.id === id)!)
  return buildModelSections({
    models,
    currentKey: key(current ?? RUNTIME_DEFAULT_MODEL),
    recentKeys: recent.map(key),
    now: Date.now(),
    fixed: true,
  }).map((section) => ({ label: section.label, ids: section.items.map((item) => item.id) }))
}

describe("external runtime models", () => {
  test("every runtime lists its CLI's default first, then the curated values its model flag takes", () => {
    for (const runtime of runtimes) {
      const ids = externalRuntimeModels(runtime).map((model) => model.id)
      expect(ids[0]).toBe(RUNTIME_DEFAULT_MODEL)
      expect(ids.slice(1)).toEqual(EXTERNAL_RUNTIME_MODELS[runtime].models.map((model) => model.id))
      expect(ids.length).toBeGreaterThan(3)
      expect(new Set(ids).size).toBe(ids.length)
      // Desktop refuses anything that could read as a flag or break a CLI's argv.
      for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9.-]*$/)
    }
    expect(externalRuntimeModels("claude-code").map((model) => model.id)).toEqual(
      expect.arrayContaining(["opus", "sonnet", "claude-opus-5-5"]),
    )
    expect(externalRuntimeModels("codex").map((model) => model.id)).toContain("gpt-5.5")
    expect(externalRuntimeModels("cursor").map((model) => model.id)).toEqual(
      expect.arrayContaining(["auto", "composer-2.5"]),
    )
  })

  test("the picker shows the runtime as one section named after it, in the list's own order", () => {
    // A workspace still on its default: that is the current model, and the runtime's section lists the rest.
    expect(sections("codex")).toEqual([
      { label: "Current model", ids: [RUNTIME_DEFAULT_MODEL] },
      { label: "Codex", ids: EXTERNAL_RUNTIME_MODELS.codex.models.map((model) => model.id) },
    ])
    // With nothing current above it, the default leads the runtime's own section.
    const listed = buildModelSections({ models: externalRuntimeModels("cursor"), now: Date.now(), fixed: true })
    expect(listed.map((section) => section.label)).toEqual(["Cursor Agent"])
    expect(listed[0].items.map((item) => item.id)).toEqual([
      RUNTIME_DEFAULT_MODEL,
      ...EXTERNAL_RUNTIME_MODELS.cursor.models.map((model) => model.id),
    ])
  })

  test("recently used models lead, and are not repeated in the runtime's section", () => {
    // Unlike a provider of Vector's, the runtime's list never closes and shows no count, so a repeat would only show
    // the same row twice.
    const [recent, runtime] = sections("claude-code", "opus", ["opus", "sonnet", RUNTIME_DEFAULT_MODEL])
    expect(recent).toEqual({ label: "Recently used", ids: ["opus", "sonnet", RUNTIME_DEFAULT_MODEL] })
    expect(runtime.label).toBe("Claude Code")
    expect(runtime.ids).not.toContain("opus")
    expect(runtime.ids[0]).toBe("fable")
  })

  test("the picker state speaks the CLI's value, and the default is no value at all", () => {
    const sent: (string | undefined)[] = []
    const state = (current?: string) =>
      externalRuntimeModelState({
        runtime: () => "claude-code",
        current: () => current,
        recent: () => [
          { id: "sonnet", at: 2 },
          { id: "gone-model", at: 1 },
        ],
        set: (value) => sent.push(value),
      })
    expect(state().current()?.id).toBe(RUNTIME_DEFAULT_MODEL)
    expect(state("opus").current()?.name).toBe("Opus (latest)")
    // A recent value the list no longer has is left out rather than shown as a blank row.
    expect(state().recent!().map((model) => model?.id)).toEqual(["sonnet", undefined])

    const provider = state().list()[0].provider.id
    state().set({ providerID: provider, modelID: "claude-opus-5-5" })
    state("opus").set({ providerID: provider, modelID: RUNTIME_DEFAULT_MODEL })
    state().set(undefined)
    expect(sent).toEqual(["claude-opus-5-5", undefined, undefined])
  })

  test("a model chosen before the list changed still shows as what the workspace runs", () => {
    const models = externalRuntimeModels("cursor", "retired-model")
    expect(models.at(-1)?.id).toBe("retired-model")
    expect(externalRuntimeModelName("cursor", "retired-model")).toBe("retired-model")
    expect(externalRuntimeModels("cursor", "auto").filter((model) => model.id === "auto")).toHaveLength(1)
  })

  test("the composer's control names the default until a model is chosen", () => {
    for (const runtime of runtimes) expect(externalRuntimeModelName(runtime, undefined)).toBe("Default model")
    expect(externalRuntimeModelName("claude-code", "opus")).toBe("Opus (latest)")
    expect(externalRuntimeModelName("codex", "gpt-5.5")).toBe("GPT-5.5")
    expect(externalRuntimeModelName("cursor", "composer-2.5")).toBe("Composer 2.5")
  })

  test("each runtime remembers its picks, newest first, and a new agent starts on the last one", () => {
    const ids = (picks: { id: string }[]) => picks.map((pick) => pick.id)
    const first = rememberRuntimeModel(undefined, "opus", 1)
    expect(first).toEqual([{ id: "opus", at: 1 }])
    const second = rememberRuntimeModel(first, "sonnet", 2)
    expect(ids(second)).toEqual(["sonnet", "opus"])
    // Picking a model again moves it to the front with the new time.
    expect(rememberRuntimeModel(second, "opus", 3)).toEqual([
      { id: "opus", at: 3 },
      { id: "sonnet", at: 2 },
    ])
    // Going back to the default is a pick too, so the next agent starts on the default.
    const reset = rememberRuntimeModel(second, undefined, 3)
    expect(ids(reset)).toEqual([RUNTIME_DEFAULT_MODEL, "sonnet", "opus"])
    expect(launchRuntimeModel(reset)).toBeUndefined()
    expect(launchRuntimeModel(second)).toBe("sonnet")
    expect(launchRuntimeModel(undefined)).toBeUndefined()
    const many = ["a", "b", "c", "d", "e", "f"].reduce<ReturnType<typeof rememberRuntimeModel>>(
      (picks, id, index) => rememberRuntimeModel(picks, id, index),
      [],
    )
    expect(ids(many)).toEqual(["f", "e", "d", "c", "b"])
  })

  test("a model the CLI refused leaves Recently used, and no new agent starts on it until it is picked again", () => {
    const pickedAt = Date.parse("2026-10-23T10:00:00.000Z")
    const refusal = { model: "claude-nope", at: "2026-10-23T10:05:00.000Z" }
    const picks = rememberRuntimeModel(rememberRuntimeModel(undefined, "sonnet", pickedAt - 1), "claude-nope", pickedAt)
    expect(launchRuntimeModel(picks)).toBe("claude-nope")

    const kept = forgetRefusedRuntimeModel(picks, refusal)
    expect(kept.map((pick) => pick.id)).toEqual(["sonnet"])
    // The launcher starts on the pick before the refused one, and the picker no longer lists it as recently used.
    expect(launchRuntimeModel(kept)).toBe("sonnet")
    const state = externalRuntimeModelState({
      runtime: () => "claude-code",
      current: () => launchRuntimeModel(kept),
      recent: () => kept,
      set: () => {},
    })
    expect(state.recent!().map((model) => model?.id)).toEqual(["sonnet"])

    // The same refusal, read again on the next poll, leaves a pick made after it alone.
    const repicked = rememberRuntimeModel(kept, "claude-nope", Date.parse(refusal.at) + 1)
    expect(forgetRefusedRuntimeModel(repicked, refusal)).toEqual(repicked)
    expect(launchRuntimeModel(forgetRefusedRuntimeModel(repicked, refusal))).toBe("claude-nope")
    // With nothing else picked, the next agent starts on the CLI's default.
    expect(
      launchRuntimeModel(forgetRefusedRuntimeModel(rememberRuntimeModel(undefined, "claude-nope", 1), refusal)),
    ).toBe(undefined)
    expect(forgetRefusedRuntimeModel(undefined, refusal)).toEqual([])
  })
})
