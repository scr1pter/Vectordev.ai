import type { ModelSelectorModelState } from "@/components/dialog-select-model"
import type { PickerModel } from "@/utils/provider-brand"
import { EXTERNAL_RUNTIMES, type ExternalRuntime } from "./external-runtimes"

/* The models each external agent's CLI accepts for its model flag, in the order the picker lists them after the CLI's
   default. This is the one place to update when a vendor ships or retires a model. Desktop passes whatever value is
   chosen straight to the CLI (packages/desktop/src/main/external-agents.ts, runtimeArguments), so a value the CLI
   refuses comes back as the CLI's own error and the workspace goes back to the default.

   None of the three CLIs can list its models offline, so every list here is curated by hand:
   - Claude Code (`claude --model`, checked against 2.1.215): `claude --help` names the aliases `fable`, `opus` and
     `sonnet` for the latest model of each family and full model names such as `claude-fable-5`; there is no command
     that lists models. `haiku` is the same kind of alias. The full ids are Anthropic's current models.
   - Codex (`codex exec --model`, and `-c model="…"` on `codex exec resume`): Codex has no offline listing. Through a
     ChatGPT sign-in the Codex backend serves the GPT-5 generation onward (the rule in
     packages/engine/src/plugin/openai/codex.ts); the ids are those models from Vector's bundled OpenAI catalog.
   - Cursor Agent (`cursor-agent --model`, checked against 2026.09.02): `cursor-agent models` and `--list-models` ask
     Cursor's servers what the signed-in account may use, so they need the account and the network. The Composer ids
     and `gpt-5.5` appear in the installed CLI itself, and its `--help` names Claude models by their full id
     (`claude-opus-4-8`). `auto` lets Cursor pick. */
export const EXTERNAL_RUNTIME_MODELS: Record<ExternalRuntime, { mark: string; models: readonly CliModel[] }> = {
  "claude-code": {
    mark: "anthropic",
    models: [
      { id: "fable", name: "Fable (latest)" },
      { id: "opus", name: "Opus (latest)" },
      { id: "sonnet", name: "Sonnet (latest)" },
      { id: "haiku", name: "Haiku (latest)" },
      { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
      { id: "claude-fable-5", name: "Claude Fable 5" },
      { id: "claude-opus-5", name: "Claude Opus 5" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    ],
  },
  codex: {
    mark: "openai",
    models: [
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
      { id: "gpt-6-sol", name: "GPT-6 Sol" },
      { id: "gpt-6-luna", name: "GPT-6 Luna" },
      { id: "gpt-6-astra", name: "GPT-6 Astra" },
      { id: "gpt-5.6", name: "GPT-5.6" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
      { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark" },
    ],
  },
  cursor: {
    mark: "cursor",
    models: [
      { id: "auto", name: "Auto" },
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { id: "gpt-6-sol", name: "GPT-6 Sol" },
      { id: "gpt-5.5", name: "GPT-5.5" },
    ],
  },
}

type CliModel = { id: string; name: string }

/** The picker row that passes no model flag, so the CLI runs the model it is set to use. Never sent to a CLI. */
export const RUNTIME_DEFAULT_MODEL = "runtime-default"

const RECENT_LIMIT = 5

/** The runtime's picker rows: its default first, then its curated models. A value chosen before the list changed
    stays listed, last, so the picker can still show what the workspace runs. */
export function externalRuntimeModels(runtime: ExternalRuntime, current?: string): PickerModel[] {
  const catalog = EXTERNAL_RUNTIME_MODELS[runtime]
  const listed = [{ id: RUNTIME_DEFAULT_MODEL, name: "Default model" }, ...catalog.models]
  const kept = current && !listed.some((model) => model.id === current) ? [{ id: current, name: current }] : []
  // A provider-shaped row, so the picker draws the runtime as its one section with the vendor's mark. "custom"
  // marks a list the host supplies, which the picker never hides as an unsupported provider.
  const provider = { id: catalog.mark, name: EXTERNAL_RUNTIMES[runtime].label, source: "custom" }
  return [...listed, ...kept].map((model) => ({ ...model, provider }))
}

/** What the composer's model control reads for a workspace's chosen value; undefined is the CLI's default. */
export function externalRuntimeModelName(runtime: ExternalRuntime, value: string | undefined) {
  return externalRuntimeModels(runtime, value).find((model) => model.id === (value ?? RUNTIME_DEFAULT_MODEL))!.name
}

/** A runtime's recently used values, newest first, with the default kept as its own entry. */
export function rememberRuntimeModel(recent: readonly string[] | undefined, value: string | undefined) {
  const id = value ?? RUNTIME_DEFAULT_MODEL
  return [id, ...(recent ?? []).filter((item) => item !== id)].slice(0, RECENT_LIMIT)
}

/** The value a new workspace for `runtime` starts on: the one last picked for it, else the CLI's default. */
export function launchRuntimeModel(recent: readonly string[] | undefined) {
  const last = recent?.[0]
  return last && last !== RUNTIME_DEFAULT_MODEL ? last : undefined
}

/** Vector's model picker over one runtime's CLI models. `current` and `set` speak the CLI's value, undefined for its
    default, so the default row never reaches desktop as a model name. */
export function externalRuntimeModelState(input: {
  runtime: () => ExternalRuntime
  current: () => string | undefined
  recent: () => readonly string[] | undefined
  set: (value: string | undefined) => void
}): ModelSelectorModelState {
  const list = () => externalRuntimeModels(input.runtime(), input.current())
  const row = (id: string) => list().find((model) => model.id === id)
  return {
    list,
    visible: () => true,
    current: () => row(input.current() ?? RUNTIME_DEFAULT_MODEL),
    recent: () => (input.recent() ?? []).map(row),
    set: (key) => input.set(!key || key.modelID === RUNTIME_DEFAULT_MODEL ? undefined : key.modelID),
  }
}
