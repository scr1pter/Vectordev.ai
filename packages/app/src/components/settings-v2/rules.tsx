import { createEffect, createSignal, For, Show } from "solid-js"

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

function scopeLabel(rule: RepoRule) {
  const where = rule.repositoryPath ? rule.repositoryPath.split(/[\\/]/).filter(Boolean).at(-1) : "Every project"
  if (!rule.filePatterns.length) return where
  return `${where} · ${rule.filePatterns.join(", ")}`
}

export function ruleRepositoryPath(repositoryPath?: string) {
  return repositoryPath?.trim() ?? ""
}

export function ruleSaveInput(input: {
  id: string
  description: string
  repositoryPath: string
  filePatterns: string
}): SaveRepoRuleInput {
  return {
    id: input.id || undefined,
    description: input.description,
    repositoryPath: input.repositoryPath.trim(),
    filePatterns: input.filePatterns
      .split(",")
      .map((pattern) => pattern.trim())
      .filter(Boolean),
  }
}

export function ruleDeleteAction(confirmingID: string, ruleID: string) {
  return confirmingID === ruleID ? "delete" : "confirm"
}

// Standards the team writes in plain English, scoped globally or to a
// repository and optionally to the files they govern. Repository rules travel
// with the clone while global rules stay in Vector's local configuration.
export function SettingsRulesV2(props: { repositoryPath?: string }) {
  const [rules, setRules] = createSignal<RepoRule[]>([])
  const [description, setDescription] = createSignal("")
  const [repository, setRepository] = createSignal("")
  const [patterns, setPatterns] = createSignal("")
  const [editing, setEditing] = createSignal("")
  const [confirmingDelete, setConfirmingDelete] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [unavailable, setUnavailable] = createSignal(false)
  const projectRoot = () => ruleRepositoryPath(props.repositoryPath)

  const message = (action: string, cause: unknown) =>
    `${action}: ${cause instanceof Error ? cause.message : String(cause)}`

  const refresh = async () => {
    const bridge = api()
    if (!bridge) {
      setUnavailable(true)
      return
    }
    setUnavailable(false)
    // Scoped to the repository this panel was opened for. Calling list() bare
    // returned every rule from every project, so each repo's panel showed all
    // of them and "project rules" were not per-project at all.
    const next = await bridge.list(projectRoot()).catch((cause: unknown) => {
      setError(message("Vector could not load repository rules", cause))
      return undefined
    })
    if (!next) return
    setError("")
    setRules(next)
  }

  createEffect(() => {
    const root = projectRoot()
    if (!editing()) setRepository(root)
    // Re-read whenever the repository changes: the panel is reused across
    // projects, so a stale list would show the previous repo's rules.
    void refresh()
  })

  const reset = () => {
    setEditing("")
    setConfirmingDelete("")
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
      .save(
        ruleSaveInput({
          id: editing(),
          description: description(),
          repositoryPath: repository(),
          filePatterns: patterns(),
        }),
      )
      .catch((cause: unknown) => {
        setError(message("Vector could not save that rule", cause))
        return undefined
      })
    setBusy(false)
    if (!saved) return
    reset()
    await refresh()
  }

  const edit = (rule: RepoRule) => {
    setConfirmingDelete("")
    setEditing(rule.id)
    setDescription(rule.description)
    setRepository(rule.repositoryPath)
    setPatterns(rule.filePatterns.join(", "))
    setError("")
  }

  const toggle = async (rule: RepoRule) => {
    const bridge = api()
    if (!bridge || busy()) return
    setConfirmingDelete("")
    setBusy(true)
    setError("")
    const saved = await bridge
      .save({
        id: rule.id,
        description: rule.description,
        repositoryPath: rule.repositoryPath,
        filePatterns: rule.filePatterns,
        enabled: !rule.enabled,
      })
      .catch((cause: unknown) => {
        setError(message(`Vector could not ${rule.enabled ? "disable" : "enable"} that rule`, cause))
        return undefined
      })
    setBusy(false)
    if (!saved) return
    await refresh()
  }

  const remove = async (rule: RepoRule) => {
    const bridge = api()
    if (!bridge || busy()) return
    if (ruleDeleteAction(confirmingDelete(), rule.id) === "confirm") {
      setConfirmingDelete(rule.id)
      setError("")
      return
    }
    setConfirmingDelete("")
    setBusy(true)
    setError("")
    const next = await bridge.remove(rule.id).catch((cause: unknown) => {
      setError(message("Vector could not delete that rule", cause))
      return undefined
    })
    setBusy(false)
    if (!next) return
    // Not setRules(next): deleteRepoRule returns every rule, unscoped, which
    // would repopulate this panel with other projects' rules. Re-read scoped.
    await refresh()
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
                Repository rules are available in the Vector desktop app after it connects to this workspace.
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
          </Show>
          <Show when={error()}>
            <p class="settings-v2-error" role="alert">{error()}</p>
          </Show>
        </div>
      </div>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Active rules</h3>
            <p class="settings-v2-card-description">
              Repository rules live in <code>.vector/RULES.md</code> and travel with the clone. Every-project rules stay
              in Vector's local global rules file.
            </p>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <Show
            when={!unavailable()}
            fallback={
              <p class="settings-v2-card-description">
                Connect the Vector desktop app to view rules for this workspace.
              </p>
            }
          >
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
                        {confirmingDelete() === rule.id ? "Confirm delete" : "Delete"}
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </section>
  )
}
