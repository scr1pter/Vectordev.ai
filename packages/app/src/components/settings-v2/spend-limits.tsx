import { Component, For, Show, createResource, createSignal } from "solid-js"
import {
  clearSpendPolicyCache,
  spendLimitsApi,
  type SpendLimitSet,
  type SpendLimitsApi,
  type SpendPolicy,
} from "@/features/economics/spend-limits-api"
import {
  LIMIT_FIELDS,
  columnWarnAt,
  parseUsd,
  parseWarnAt,
  recentRunMeta,
  summaryLine,
  withLimit,
  withWarnAt,
  type LimitKey,
} from "./spend-limits-model"
import "./settings-v2.css"

const COLUMNS: readonly { key: keyof SpendPolicy; title: string }[] = [
  { key: "interactive", title: "While you watch" },
  { key: "unattended", title: "Left alone" },
]

// Bound to the desktop spend ledger. The web build has no ledger, so the
// settings navigation hides this page there; the fallback covers a direct link.
export const SettingsSpendLimitsV2: Component<{ repositoryPath?: string }> = (props) => {
  const api = spendLimitsApi()
  return (
    <section class="settings-v2-page">
      <div class="settings-v2-page-hero">
        <div>
          <p class="settings-v2-page-kicker">Spend</p>
          <h2 class="settings-v2-page-title">Spend limits</h2>
          <p class="settings-v2-page-subtitle">
            Caps are checked after every model step. Vector stops a run within one step of its cap, and before a step it
            estimates would cross it.
          </p>
        </div>
      </div>
      <Show
        when={api}
        fallback={<p class="settings-v2-card-description">Spend limits are kept by the Vector desktop app.</p>}
      >
        {(ledger) => <SpendLimitsPanel api={ledger()} repositoryPath={props.repositoryPath} />}
      </Show>
    </section>
  )
}

function SpendLimitsPanel(props: { api: SpendLimitsApi; repositoryPath?: string }) {
  const [error, setError] = createSignal("")
  const [policy, { mutate }] = createResource(() => props.api.limits())
  const [summary, { refetch: refetchSummary }] = createResource(() => props.api.status(props.repositoryPath))
  const [recent] = createResource(() => props.api.recent(20))

  const save = async (column: keyof SpendPolicy, next: SpendLimitSet) => {
    setError("")
    const saved = await props.api.setLimits({ [column]: next }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Vector could not save the limit.")
      return undefined
    })
    if (!saved) return
    mutate(saved)
    clearSpendPolicyCache()
    void refetchSummary()
  }

  const setLimit = (column: keyof SpendPolicy, key: LimitKey, text: string) => {
    const parsed = parseUsd(text)
    if (!parsed.ok) return setError("Enter a dollar amount above zero, or leave the field empty for no limit.")
    void save(column, withLimit(policy()?.[column] ?? {}, key, parsed.usd))
  }

  const setWarnAt = (column: keyof SpendPolicy, text: string) => {
    const parsed = parseWarnAt(text)
    if (!parsed.ok) return setError("Enter a percentage between 1 and 100, or leave the field empty for 80%.")
    void save(column, withWarnAt(policy()?.[column] ?? {}, parsed.warnAt))
  }

  return (
    <>
      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">
              <Show when={summary()} fallback="Loading totals…">
                {(value) => summaryLine(value())}
              </Show>
            </h3>
            <Show when={summary()?.project}>
              {(project) => (
                <p class="settings-v2-card-description">
                  This project: {summaryLine({ all: { day: project().day, month: project().month } })}
                </p>
              )}
            </Show>
            <Show when={(summary()?.all.month.unmeasuredRuns ?? 0) > 0}>
              <p class="settings-v2-card-description">
                Unmeasured runs reported no usage. They are not counted as free, and they cannot be held to a dollar
                cap.
              </p>
            </Show>
          </div>
        </div>
      </div>

      <div>
        <p class="settings-v2-card-description">
          While you watch covers chats and parallel agents you start. Left alone covers automations.
        </p>
        <p class="settings-v2-card-description">
          Chats count against the per-run cap. Day and month totals include automations and parallel agents.
        </p>
      </div>

      <div class="settings-v2-section-grid">
        <For each={COLUMNS}>
          {(column) => (
            <div class="settings-v2-card">
              <div class="settings-v2-card-head">
                <div class="settings-v2-card-copy">
                  <h3 class="settings-v2-card-title">{column.title}</h3>
                </div>
              </div>
              <div class="settings-v2-card-body">
                <For each={LIMIT_FIELDS}>
                  {(field) => (
                    <label class="settings-v2-field">
                      <span class="settings-v2-field-label">{field.label}</span>
                      <input
                        class="settings-v2-textarea"
                        inputmode="decimal"
                        placeholder="No limit"
                        disabled={policy.loading}
                        value={policy()?.[column.key][field.key]?.usd ?? ""}
                        onChange={(event) => setLimit(column.key, field.key, event.currentTarget.value)}
                      />
                    </label>
                  )}
                </For>
                <label class="settings-v2-field">
                  <span class="settings-v2-field-label">Warn at</span>
                  <input
                    class="settings-v2-textarea"
                    inputmode="decimal"
                    placeholder="80%"
                    disabled={policy.loading}
                    value={warnAtText(policy()?.[column.key])}
                    onChange={(event) => setWarnAt(column.key, event.currentTarget.value)}
                  />
                </label>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={error()}>
        <p class="settings-v2-error" role="alert">
          {error()}
        </p>
      </Show>

      <div class="settings-v2-card settings-v2-card--wide">
        <div class="settings-v2-card-head">
          <div class="settings-v2-card-copy">
            <h3 class="settings-v2-card-title">Recent runs</h3>
          </div>
        </div>
        <div class="settings-v2-card-body">
          <Show
            when={(recent() ?? []).length > 0}
            fallback={<p class="settings-v2-card-description">No runs recorded yet.</p>}
          >
            <div>
              <For each={recent()}>
                {(run) => (
                  <div class="settings-v2-list-item">
                    <p class="settings-v2-list-title">{run.model || "Unknown model"}</p>
                    <p class="settings-v2-list-meta">{recentRunMeta(run)}</p>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </>
  )
}

function warnAtText(set: SpendLimitSet | undefined) {
  const warnAt = set ? columnWarnAt(set) : undefined
  return warnAt === undefined ? "" : `${Math.round(warnAt * 100)}%`
}
