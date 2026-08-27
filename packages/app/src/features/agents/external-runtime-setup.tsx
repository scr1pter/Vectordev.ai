import { createSignal, For, Show } from "solid-js"
import { externalRuntimeSetup, setupSteps, type ExternalRuntime } from "./external-runtimes"

function CommandRow(props: { label: string; command: string }) {
  const [copied, setCopied] = createSignal(false)
  return (
    <div class="mb-1.5">
      <div class="vx-label mb-1">{props.label}</div>
      <button
        type="button"
        class="vx-cmd"
        onClick={() => {
          void navigator.clipboard?.writeText(props.command)
          setCopied(true)
          setTimeout(() => setCopied(false), 1_500)
        }}
      >
        <span class="min-w-0 flex-1 truncate">{props.command}</span>
        <span class="vx-cmd__hint">{copied() ? "Copied" : "Copy"}</span>
      </button>
    </div>
  )
}

// Shown when a selected runtime is not installed, or is installed but signed
// out. Without this the picker is a dead end: it reports the blocker and never
// says what clearing it means.
export function ExternalRuntimeSetupPanel(props: {
  runtime: ExternalRuntime
  onRecheck: () => void
  checking?: boolean
  mode?: "install" | "sign-in"
}) {
  const setup = () => externalRuntimeSetup(props.runtime)
  const signInOnly = () => props.mode === "sign-in"
  return (
    <Show when={setup()}>
      <div class="vx-card mt-2 px-3.5 py-3">
        <div class="mb-1 text-[11.5px] font-semibold text-[color:var(--vx-text)]">
          {signInOnly() ? `Sign in to ${setup()!.label}` : `Set up ${setup()!.label}`}
        </div>
        <p class="mb-2.5 text-[11px] leading-[1.45] text-[color:var(--vx-text-muted)]">
          {signInOnly()
            ? `${setup()!.label} is installed on this computer but is not signed in, so every run would stop before it started. Run this once in a terminal, then check again.`
            : setup()!.note}
        </p>
        <For each={setupSteps(props.runtime, props.mode ?? "install")}>
          {(step) => <CommandRow label={step.label} command={step.command} />}
        </For>
        <div class="mt-2.5 flex items-center gap-2.5">
          <button
            type="button"
            class="rounded-[8px] px-3 py-1.5 text-[11px] font-semibold text-white transition disabled:opacity-50"
            style={{ background: "var(--vx-gradient)" }}
            disabled={props.checking}
            onClick={props.onRecheck}
          >
            {props.checking ? "Checking…" : "Check again"}
          </button>
          <span class="text-[10px] text-[color:var(--vx-text-muted)]">
            Vector runs your own CLI — it never asks for another key.
          </span>
        </div>
      </div>
    </Show>
  )
}
