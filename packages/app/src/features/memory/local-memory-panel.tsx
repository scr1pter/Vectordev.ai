import { onCleanup, onMount, Show } from "solid-js"
import { createLocalMemoryEditor, type LocalMemoryApi } from "./local-memory-editor"

function api(): LocalMemoryApi | undefined {
  return (globalThis.window as unknown as { api?: { localMemory?: LocalMemoryApi } } | undefined)?.api?.localMemory
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Local memory is the feature most likely to make someone uneasy, so this panel
// shows exactly what is stored, where it lives on disk, and offers a real
// delete rather than a toggle that merely stops reading it.
export function LocalMemoryPanel() {
  const editor = createLocalMemoryEditor(api)

  onMount(() => void editor.refresh())
  onCleanup(editor.cancelEdit)

  return (
    <div class="flex flex-col gap-3">
      <div>
        <h3 class="text-[13px] font-semibold text-white">Local memory</h3>
        <p class="mt-1 text-[12px] leading-relaxed text-white/55">
          Save durable facts about how you work and Vector will carry them across every project and repository. Memory
          is a plain Markdown file stored only on this computer. When the file exists, Vector automatically includes its
          contents in built-in agent context sent to the model provider you selected.
        </p>
      </div>

      <Show
        when={!editor.unavailable()}
        fallback={<p class="text-[12px] text-white/45">Local memory is available in the Vector desktop app.</p>}
      >
        <div class="rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] px-3 py-2.5">
          <Show
            when={editor.state()?.exists}
            fallback={<p class="text-[12px] text-white/50">Nothing remembered yet.</p>}
          >
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-white/55">
              <span>
                <span class="text-white/80">{editor.state()!.entries}</span> entries
              </span>
              <span>{formatBytes(editor.state()!.bytes)}</span>
              <Show when={editor.state()!.updatedAt}>
                <span>updated {new Date(editor.state()!.updatedAt!).toLocaleDateString()}</span>
              </Show>
            </div>
          </Show>
          <Show when={editor.state()?.path}>
            <div class="mt-1.5 truncate font-mono text-[10.5px] text-white/35" title={editor.state()!.path}>
              {editor.state()!.path}
            </div>
          </Show>
        </div>

        <Show when={editor.editing()}>
          <div class="rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)] p-3">
            <label for="vector-local-memory" class="text-[11.5px] font-medium text-white/70">
              Memory (Markdown)
            </label>
            <textarea
              id="vector-local-memory"
              class="mt-2 min-h-[180px] w-full resize-y rounded-[7px] border border-[color:var(--vx-line)] bg-black/15 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-white/80 outline-none transition focus:border-[color:var(--vx-purple)]"
              placeholder={"- I use Bun for JavaScript projects.\n- Keep explanations concise."}
              value={editor.draft()}
              onInput={(event) => editor.setDraft(event.currentTarget.value)}
              autofocus
            />
            <p class="mt-1.5 text-[10.5px] leading-4 text-white/40">
              Store preferences and stable working conventions only. Do not put passwords, API keys, tokens, or private
              personal data here.
            </p>
            <div class="mt-3 flex gap-2">
              <button
                type="button"
                disabled={editor.busy() || !editor.draft().trim()}
                class="rounded-[6px] bg-[color:var(--vx-purple)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                onClick={() => void editor.save()}
              >
                {editor.busy() ? "Saving…" : "Save memory"}
              </button>
              <button
                type="button"
                disabled={editor.busy()}
                class="rounded-[6px] px-3 py-1.5 text-[12px] text-white/60 hover:text-white disabled:opacity-50"
                onClick={editor.cancelEdit}
              >
                Cancel
              </button>
            </div>
          </div>
        </Show>

        <Show when={!editor.editing() && editor.state()?.exists && editor.state()!.content}>
          <details class="rounded-[8px] border border-[color:var(--vx-line)] bg-[color:var(--vx-surface)]">
            <summary class="cursor-pointer px-3 py-2 text-[12px] text-white/65">
              Show everything Vector remembers
            </summary>
            <pre class="max-h-[240px] overflow-auto whitespace-pre-wrap break-words border-t border-[color:var(--vx-line)] px-3 py-2.5 text-[11.5px] leading-relaxed text-white/70">
              {editor.state()!.content}
            </pre>
          </details>
        </Show>

        <Show when={!editor.editing()}>
          <button
            type="button"
            class="self-start rounded-[6px] border border-[color:var(--vx-line)] px-3 py-1.5 text-[12px] text-white/70 transition hover:border-[color:var(--vx-purple)] hover:text-white"
            onClick={editor.edit}
          >
            {editor.state()?.exists ? "Edit local memory" : "Add local memory"}
          </button>
        </Show>

        <Show when={!editor.editing() && editor.state()?.exists}>
          <Show
            when={editor.confirming()}
            fallback={
              <button
                type="button"
                class="self-start rounded-[6px] border border-[color:var(--vx-line)] px-3 py-1.5 text-[12px] text-white/70 transition hover:border-rose-400/50 hover:text-rose-200"
                onClick={() => editor.setConfirming(true)}
              >
                Erase local memory
              </button>
            }
          >
            <div class="rounded-[8px] border border-rose-400/40 bg-rose-400/[0.07] px-3 py-2.5">
              <p class="text-[12px] text-rose-100">
                This deletes Vector's local memory file. Vector cannot restore it after deletion.
              </p>
              <div class="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={editor.busy()}
                  class="rounded-[6px] bg-rose-500/85 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                  onClick={() => void editor.clear()}
                >
                  {editor.busy() ? "Erasing…" : "Erase everything"}
                </button>
                <button
                  type="button"
                  class="rounded-[6px] px-3 py-1.5 text-[12px] text-white/60 hover:text-white"
                  onClick={() => editor.setConfirming(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </Show>
        </Show>
        <Show when={editor.error()}>
          <p class="text-[12px] text-rose-200" role="alert">
            {editor.error()}
          </p>
        </Show>
      </Show>
    </div>
  )
}
