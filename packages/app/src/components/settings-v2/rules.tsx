import { createSignal, For, onMount, Show } from "solid-js"

type RepoRule = {
  id: string
  description: string
  repositoryPath: string
  filePatterns: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

type SaveRepoRuleInput = {
  id?: string
  description: string
  repositoryPath: string
  filePatterns: string[]
  enabled?: boolean
}

type RepoRulesApi = {
  list: (repositoryPath?: string) => Promise<RepoRule[]>
  save: (input: SaveRepoRuleInput) => Promise<RepoRule>
  remove: (id: string) => Promise<RepoRule[]>
}

function api(): RepoRulesApi | undefined {
  return (globalThis.window as unknown as { api?: { repoRules?: RepoRulesApi } } | undefined)?.api?.repoRules
}

function projectRoot() {
  return (globalThis.window as unknown as { api?: { projectPath?: string } } | undefined)?.api?.projectPath ?? ""
}

function scopeLabel(rule: RepoRule) {
  const where = rule.repositoryPath ? rule.repositoryPath.split("/").filter(Boolean).at(-1) : "Every project"
  if (!rule.filePatterns.length) return where
  return `${where} · ${rule.filePatterns.join(", ")}`
}

// Standards the team writes in plain English, scoped to a repository and
// optionally to the files they govern. Saved rules are written to
// .vector/RULES.md in the repository — a committed file the engine already
// loads on every prompt — so they travel with the clone instead of living in
// one developer's application data.
export function SettingsRulesV2() {
  const [rules, setRules] = createSignal<RepoRule[]>([])
  const [description, setDescription] = createSignal("")
  const [repository, setRepository] = createSignal("")
  const [patterns, setPatterns] = createSignal("")
  const [editing, setEditing] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [unavailable, setUnavailable] = createSignal(false)

  const refresh = async () => {
    const bridge = api()
    if (!bridge) {
      setUnavailable(true)
      return
    }
    const next = await bridge.list().catch(() => undefined)
    if (next) setRules(next)
  }

  onMount(() => {
    setRepository(projectRoot())
    void refresh()
  })

  const reset = () => {
    setEditing("")
    setDescription("")
    setPatterns("")
    setRepository(projectRoot())
    setError("")
  }

  const save = async () => {
    const bridge = api()
    if (!bridge || busy()) return
    if (!description().trim()) {
      setError("Write what the rule is before saving it.")
      return
    }
    setBusy(true)
    setError("")
    const saved = await bridge
      .save({
        id: editing() || undefined,
        description: description(),
        repositoryPath: repository().trim(),
        filePatterns: patterns()
          .split(",")
          .map((pattern) => pattern.trim())
          .filter(Boolean),
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        return undefined
      })
    setBusy(false)
    if (!saved) return
    reset()
    await refresh()
  }

  const edit = (rule: RepoRule) => {
    setEditing(rule.id)
    setDescription(rule.description)
    setRepository(rule.repositoryPath)
    setPatterns(rule.filePatterns.join(", "))
    setError("")
  }

  const toggle = async (rule: RepoRule) => {
    const bridge = api()
    if (!bridge || busy()) return
    setBusy(true)
    await bridge
      .save({
        id: rule.id,
        description: rule.description,
        repositoryPath: rule.repositoryPath,
        filePatterns: rule.filePatterns,
        enabled: !rule.enabled,
      })
      .catch(() => undefined)
    setBusy(false)
    await refresh()
  }

  const remove = async (rule: RepoRule) => {
    const bridge = api()
    if (!bridge || busy()) return
    setBusy(true)
    const next = await bridge.remove(rule.id).catch(() => undefined)
    setBusy(false)
    if (next) setRules(next)
    if (editing() === rule.id) reset()
  }

  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Rules</p>
          <h2 class="settings-v2-page-title">Your house, your rules</h2>
          <p class="settings-v2-page-subtitle">
            Write a standard in plain English, point it at a repository and the files it governs, and every agent
            follows it — Vector's own, and Claude Code, Codex and Cursor too.
          </p>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">{editing() ? "Edit rule" : "Add a rule"}</h3>
            <p class="settings-v2-card-description">
              Say it the way you would say it to a new teammate. Leave the repository empty to apply it everywhere.
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <Show
            when={!unavailable()}
            fallback={
              <p class="settings-v2-card-description">
                Rules are stored on your computer and activate once Vector connects to this workspace.
              </p>
            }
          >
            <textarea
              class="settings-v2-textarea"
              rows="3"
              placeholder="We don't put database query logic in the controller."
              value={description()}
              onInput={(event) => setDescription(event.currentTarget.value)}
            />
            <label class="settings-v2-field" style={{ "margin-top": "12px" }}>
              <span class="settings-v2-field-label">Repository</span>
              <input
                class="settings-v2-textarea"
                placeholder="Every project"
                value={repository()}
                onInput={(event) => setRepository(event.currentTarget.value)}
              />
            </label>
            <label class="settings-v2-field">
              <span class="settings-v2-field-label">File paths — blank for the whole repository</span>
              <input
                class="settings-v2-textarea"
                placeholder="src/app/web/*.tsx, server/**/*.ts"
                value={patterns()}
                onInput={(event) => setPatterns(event.currentTarget.value)}
              />
            </label>
            <div class="settings-v2-action-grid">
              <button type="button" class="settings-v2-action" disabled={busy()} onClick={() => void save()}>
                {editing() ? "Save changes" : "Add rule"}
              </button>
              <Show when={editing()}>
                <button type="button" class="settings-v2-action" disabled={busy()} onClick={reset}>
                  Cancel
                </button>
              </Show>
            </div>
            <Show when={error()}>
              <p class="settings-v2-error">{error()}</p>
            </Show>
          </Show>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Active rules</h3>
            <p class="settings-v2-card-description">
              Saved to <code>.vector/RULES.md</code> in each repository, so committing that file shares the rules with
              your whole team.
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <Show
            when={rules().length}
            fallback={<p class="settings-v2-card-description">No rules yet. The first one takes about ten seconds.</p>}
          >
            <For each={rules()}>
              {(rule) => (
                <div class="settings-v2-list-item" classList={{ "is-off": !rule.enabled }}>
                  <p class="settings-v2-list-title">{rule.description}</p>
                  <p class="settings-v2-list-meta">{scopeLabel(rule)}</p>
                  <div class="settings-v2-action-grid">
                      <button type="button" class="settings-v2-action" disabled={busy()} onClick={() => edit(rule)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        class="settings-v2-action"
                        disabled={busy()}
                        onClick={() => void toggle(rule)}
                      >
                        {rule.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        class="settings-v2-action"
                        disabled={busy()}
                        onClick={() => void remove(rule)}
                      >
                        Delete
                    </button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </section>
  )
}
