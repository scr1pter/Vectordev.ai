import { createSignal, For, Show } from "solid-js"
import { externalRuntimeSetup, setupSteps, type ExternalRuntime } from "./external-runtimes"

function CommandRow(props: { label: string; command: string }) {
  const [copied, setCopied] = createSignal(false)
  return (
    <div class="mb-1.5">
      <div class="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.09em] text-white/35">{props.label}</div>
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-canvas)] px-2.5 py-1.5 text-left font-mono text-[11px] text-white/80 transition hover:border-[color:var(--vx-purple)]"
        onClick={() => {
          void navigator.clipboard?.writeText(props.command)
          setCopied(true)
          setTimeout(() => setCopied(false), 1_500)
        }}
      >
        <span class="min-w-0 flex-1 truncate">{props.command}</span>
        <span class="shrink-0 text-[10px] text-white/45">{copied() ? "Copied" : "Copy"}</span>
      </button>
    </div>
  )
}

// Shown when a selected runtime is not installed. Without this the picker is a
// dead end: it reports "Setup needed" and never says what setup means.
export function ExternalRuntimeSetupPanel(props: { runtime: ExternalRuntime; onRecheck: () => void; checking?: boolean }) {
  const setup = () => externalRuntimeSetup(props.runtime)
  return (
    <Show when={setup()}>
      <div class="mt-2 rounded-[10px] border border-[color:var(--vx-line)] bg-white/[0.02] px-3 py-2.5">
        <div class="mb-1 text-[11px] font-semibold text-white">Set up {setup()!.label}</div>
        <p class="mb-2 text-[10.5px] leading-4 text-white/50">{setup()!.note}</p>
        <For each={setupSteps(props.runtime)}>{(step) => <CommandRow label={step.label} command={step.command} />}</For>
        <div class="mt-2 flex items-center gap-2">
          <button
            type="button"
            class="rounded-[7px] bg-[color:var(--vx-purple)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
            disabled={props.checking}
            onClick={props.onRecheck}
          >
            {props.checking ? "Checking…" : "Check again"}
          </button>
          <span class="text-[10px] text-white/35">Vector runs your own CLI — it never asks for another key.</span>
        </div>
      </div>
    </Show>
  )
}
