import { createMemo, createSignal, For, Show } from "solid-js"
import { parseReviewDiff, reviewRows } from "@/utils/unified-diff"

type ReviewChoice = "accepted" | "rejected" | "pending"

export function ParallelDiffReview(props: {
  diff: string
  disabled?: boolean
  readOnly?: boolean
  label?: string
  onMergeSelection: (selection: { hunkIds: string[]; files: string[] }) => Promise<void> | void
}) {
  const files = createMemo(() => parseReviewDiff(props.diff))
  const [choices, setChoices] = createSignal<Record<string, ReviewChoice>>({})
  const [merging, setMerging] = createSignal(false)

  const keyForFile = (path: string) => `file:${path}`
  const choice = (key: string) => choices()[key] ?? "pending"
  const decide = (key: string, value: ReviewChoice) =>
    setChoices((current) => ({ ...current, [key]: current[key] === value ? "pending" : value }))

  const accepted = createMemo(() => {
    const hunkIds: string[] = []
    const selectedFiles: string[] = []
    for (const file of files()) {
      if (!file.supportsHunks) {
        if (choice(keyForFile(file.path)) === "accepted") selectedFiles.push(file.path)
        continue
      }
      for (const hunk of file.hunks) {
        if (choice(hunk.id) === "accepted") hunkIds.push(hunk.id)
      }
    }
    return { hunkIds, files: selectedFiles }
  })
  const acceptedCount = createMemo(() => accepted().hunkIds.length + accepted().files.length)
  const rejectedCount = createMemo(() => Object.values(choices()).filter((item) => item === "rejected").length)

  const merge = async () => {
    if (!acceptedCount() || merging() || props.disabled) return
    setMerging(true)
    try {
      await props.onMergeSelection(accepted())
      setChoices({})
    } finally {
      setMerging(false)
    }
  }

  return (
    <div class="overflow-hidden rounded-2xl border border-[color:var(--vx-line)] bg-[#1d1d1f]">
      <div class="flex flex-wrap items-center gap-3 border-b border-[color:var(--vx-line)] px-4 py-3">
        <div>
          <div class="text-sm font-semibold text-white/88">{props.readOnly ? (props.label ?? "Read-only diff") : "Selective review"}</div>
          <div class="mt-0.5 text-xs text-white/45">
            {props.readOnly ? "Viewing changes — merge controls are disabled in this view." : "Approve only the exact changes you trust."}
          </div>
        </div>
        <Show when={!props.readOnly}>
          <div class="ml-auto flex items-center gap-2 text-xs">
            <span class="rounded-full bg-emerald-400/10 px-2 py-1 text-emerald-300">{acceptedCount()} approved</span>
            <span class="rounded-full bg-rose-400/10 px-2 py-1 text-rose-300">{rejectedCount()} held</span>
            <button
              type="button"
              class="rounded-lg bg-white px-3 py-1.5 font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-35"
              disabled={!acceptedCount() || merging() || props.disabled}
              onClick={() => void merge()}
            >
              {merging() ? "Merging..." : "Merge approved"}
            </button>
          </div>
        </Show>
      </div>

      <Show
        when={files().length}
        fallback={<div class="px-5 py-8 text-center text-sm text-white/45">No structured diff is available yet.</div>}
      >
        <For each={files()}>
          {(file) => (
            <section class="border-b border-[color:var(--vx-line)] last:border-b-0">
              <div class="flex items-center gap-3 bg-white/[0.025] px-4 py-3">
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-white/72">{file.path}</span>
                <Show when={!file.supportsHunks}>
                  <span class="text-[11px] text-white/38">whole file</span>
                  <Show when={!props.readOnly}>
                    <DecisionButtons
                      value={choice(keyForFile(file.path))}
                      disabled={props.disabled}
                      onDecision={(value) => decide(keyForFile(file.path), value)}
                    />
                  </Show>
                </Show>
              </div>

              <Show
                when={!file.binary && file.hunks.length}
                fallback={<div class="px-4 py-5 text-sm text-white/42">Binary or non-text change. Review and approve the complete file.</div>}
              >
                <For each={file.hunks}>
                  {(hunk) => (
                    <div class="border-t border-[color:var(--vx-line)] first:border-t-0">
                      <div class="flex items-center gap-3 px-4 py-2.5">
                        <code class="min-w-0 flex-1 truncate text-[11px] text-violet-200/62">{hunk.header}</code>
                        <Show when={file.supportsHunks && !props.readOnly}>
                          <DecisionButtons
                            value={choice(hunk.id)}
                            disabled={props.disabled}
                            onDecision={(value) => decide(hunk.id, value)}
                          />
                        </Show>
                      </div>
                      <div class="grid min-w-[760px] grid-cols-2 border-t border-[color:var(--vx-line)] font-mono text-[11px] leading-5">
                        <div class="border-r border-[color:var(--vx-line)] bg-rose-400/[0.025] px-3 py-1 text-[10px] font-sans uppercase text-rose-200/45">Before</div>
                        <div class="bg-emerald-400/[0.025] px-3 py-1 text-[10px] font-sans uppercase text-emerald-200/45">After</div>
                        <For each={reviewRows(hunk)}>
                          {(row) => (
                            <>
                              <DiffCell line={row.oldLine} text={row.oldText} tone={row.kind === "change" ? "removed" : "context"} />
                              <DiffCell line={row.newLine} text={row.newText} tone={row.kind === "change" ? "added" : "context"} />
                            </>
                          )}
                        </For>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </section>
          )}
        </For>
      </Show>
    </div>
  )
}

function DecisionButtons(props: {
  value: ReviewChoice
  disabled?: boolean
  onDecision: (value: ReviewChoice) => void
}) {
  return (
    <div class="flex items-center rounded-lg border border-[color:var(--vx-line)] bg-black/20 p-0.5">
      <button
        type="button"
        class="rounded-md px-2 py-1 text-[11px] transition"
        classList={{
          "bg-emerald-400/18 text-emerald-200": props.value === "accepted",
          "text-white/44 hover:text-emerald-200": props.value !== "accepted",
        }}
        disabled={props.disabled}
        onClick={() => props.onDecision("accepted")}
      >
        Accept
      </button>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-[11px] transition"
        classList={{
          "bg-rose-400/16 text-rose-200": props.value === "rejected",
          "text-white/44 hover:text-rose-200": props.value !== "rejected",
        }}
        disabled={props.disabled}
        onClick={() => props.onDecision("rejected")}
      >
        Hold
      </button>
    </div>
  )
}

function DiffCell(props: { line?: number; text?: string; tone: "removed" | "added" | "context" }) {
  return (
    <div
      class="grid min-h-5 grid-cols-[44px_minmax(0,1fr)] border-t border-[color:var(--vx-line)]"
      classList={{
        "bg-rose-400/[0.10] text-rose-100/78": props.tone === "removed" && props.text !== undefined,
        "bg-emerald-400/[0.10] text-emerald-100/78": props.tone === "added" && props.text !== undefined,
        "text-white/52": props.tone === "context",
        "bg-white/[0.015]": props.text === undefined,
      }}
    >
      <span class="select-none border-r border-[color:var(--vx-line)] px-2 text-right text-white/24">{props.line ?? ""}</span>
      <span class="whitespace-pre px-2">{props.text ?? ""}</span>
    </div>
  )
}
