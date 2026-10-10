import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js"
import type { LogService, SecurityReport } from "./supabase-api"
import { failed, formatWhen, NotLinked, PanelHead, type SupabasePanelProps } from "./supabase-ui"
import "./supabase.css"

// What the linked Supabase project is doing (per-service logs) and whether it
// is safe to ship (security advisors plus a leak scan, which production
// publishes are required to pass).

const SERVICES: { id: LogService; label: string }[] = [
  { id: "api", label: "API" },
  { id: "postgres", label: "Postgres" },
  { id: "auth", label: "Auth" },
  { id: "storage", label: "Storage" },
  { id: "functions", label: "Edge Functions" },
]

const WINDOWS = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 360, label: "6 hours" },
  { minutes: 1440, label: "24 hours" },
]

export function SupabaseLogs(props: SupabasePanelProps & { icon: JSX.Element }) {
  const [service, setService] = createSignal<LogService>("api")
  const [minutes, setMinutes] = createSignal(60)
  const [search, setSearch] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [entries, setEntries] = createSignal<{ at: string; message: string }[]>()
  const [truncated, setTruncated] = createSignal(false)

  const load = async () => {
    if (!props.linked || busy()) return
    setBusy(true)
    try {
      const report = await props.client.logs({
        service: service(),
        minutes: minutes(),
        search: search().trim() || undefined,
      })
      if (failed(props.notice, report)) return
      setEntries(report.entries ?? [])
      setTruncated(report.truncated === true)
    } finally {
      setBusy(false)
    }
  }

  createEffect(
    on(
      () => [props.linked, service(), minutes()] as const,
      () => void load(),
    ),
  )

  return (
    <Show
      when={props.linked}
      fallback={
        <NotLinked
          onOpenDatabase={props.onOpenDatabase}
          what="Logs come from the Supabase project this repository uses."
          icon={props.icon}
        />
      }
    >
      <div class="cloud-panel">
        <PanelHead title="Database logs" detail="Recent lines from the chosen service, newest last.">
          <button class="cloud-button" type="button" disabled={busy()} onClick={() => void load()}>
            {busy() ? "Loading…" : "Refresh"}
          </button>
        </PanelHead>
        <div class="sb-actions mt-3">
          <div class="cloud-segment">
            <For each={SERVICES}>
              {(item) => (
                <button type="button" data-active={service() === item.id} onClick={() => setService(item.id)}>
                  {item.label}
                </button>
              )}
            </For>
          </div>
          <select
            class="cloud-input"
            style={{ "color-scheme": "dark" }}
            value={String(minutes())}
            onChange={(event) => setMinutes(Number(event.currentTarget.value))}
          >
            <For each={WINDOWS}>{(item) => <option value={String(item.minutes)}>Last {item.label}</option>}</For>
          </select>
          <input
            class="cloud-input"
            placeholder="Filter text"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && void load()}
          />
        </div>
        <Show when={entries()}>
          {(lines) => (
            <>
              <pre class="cloud-log mt-3" style={{ "max-height": "460px" }}>
                {lines().length
                  ? lines()
                      .map((line) => `${line.at} ${line.message}`)
                      .join("\n")
                  : "No log lines in this window."}
              </pre>
              <Show when={truncated()}>
                <p class="cloud-muted mt-2 text-[12px]">
                  Older lines in this window are not shown; narrow it or filter.
                </p>
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}

export function SupabaseSecurity(props: SupabasePanelProps & { icon: JSX.Element }) {
  const [report, setReport] = createSignal<SecurityReport>()
  const [busy, setBusy] = createSignal(false)

  const run = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const next = await props.client.security()
      if (failed(props.notice, next)) return
      setReport(next.security)
    } finally {
      setBusy(false)
    }
  }

  createEffect(
    on(
      () => props.linked,
      (linked) => {
        setReport(undefined)
        if (linked) void run()
      },
    ),
  )

  const tone = (level: string) => (level === "ERROR" ? "error" : level === "WARN" ? "warning" : undefined)

  return (
    <Show
      when={props.linked}
      fallback={
        <NotLinked
          onOpenDatabase={props.onOpenDatabase}
          what="The security check runs against the Supabase project this repository uses."
          icon={props.icon}
        />
      }
    >
      <div class="sb-stack">
        <div class="cloud-panel cloud-gradient-edge">
          <PanelHead
            title="Security check"
            detail="Supabase's security advisors plus a scan of public environment variables and the last build for server keys. Promoting a release to production requires it to pass."
          >
            <button
              class="cloud-button"
              data-variant="primary"
              type="button"
              disabled={busy()}
              onClick={() => void run()}
            >
              {busy() ? "Checking…" : "Run check"}
            </button>
          </PanelHead>
          <Show when={report()}>
            {(current) => (
              <div class="sb-actions mt-3">
                <span
                  class="cloud-status"
                  data-tone={
                    current().status === "passed" ? "success" : current().status === "failed" ? "error" : "warning"
                  }
                >
                  {current().status}
                </span>
                <span class="cloud-muted text-[12px]">
                  {current().detail} Checked {formatWhen(current().checkedAt)}.
                </span>
              </div>
            )}
          </Show>
        </div>
        <Show when={report()}>
          {(current) => (
            <div class="cloud-list">
              <For each={[...current().environment, ...current().bundle]}>
                {(finding) => (
                  <div class="cloud-row">
                    <span class="sb-finding min-w-0 flex-1">
                      <strong class="text-[13px]">{finding.where}</strong>
                      <p>{finding.reason}</p>
                    </span>
                    <span class="cloud-status" data-tone={tone(finding.level)}>
                      {finding.level.toLowerCase()}
                    </span>
                  </div>
                )}
              </For>
              <For
                each={current().advisors}
                fallback={
                  <Show when={!current().environment.length && !current().bundle.length}>
                    <p class="cloud-muted text-[12px]">{current().advisorsError ?? "Nothing to report."}</p>
                  </Show>
                }
              >
                {(lint) => (
                  <div class="cloud-row cloud-row-block">
                    <span class="sb-finding min-w-0 flex-1">
                      <strong class="text-[13px]">
                        {lint.title}
                        {lint.entity ? ` · ${lint.entity}` : ""}
                      </strong>
                      <Show when={lint.detail}>
                        <p>{lint.detail}</p>
                      </Show>
                      <Show when={lint.remediation}>
                        <p>{lint.remediation}</p>
                      </Show>
                    </span>
                    <span class="cloud-status" data-tone={tone(lint.level)}>
                      {lint.level.toLowerCase()}
                    </span>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>
    </Show>
  )
}
