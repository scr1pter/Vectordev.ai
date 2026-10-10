/** @jsxImportSource react */
import { Option, Schema } from "effect"
import { UsageSummary } from "@vectordevai/schema/usage-summary"
import { RefreshCw } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { readAccountApiResponse, rememberAccountReturnPath, vectorAccountClient } from "../../../lib/account-client"
import { GoogleMark } from "../account/AuthPage"
import "../account/account.css"
import "./usage.css"

type State =
  | { kind: "loading" }
  | { kind: "signin"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "ready"; summary: UsageSummary.Summary }

const decodeSummary = Schema.decodeUnknownOption(UsageSummary.Summary)
const whole = new Intl.NumberFormat("en-US")
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 })
const change = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0, signDisplay: "exceptZero" })
const shortDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const longDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
const monthName = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })

// The owner's usage dashboard. The server decides who may read it (the admin allowlist,
// signed in with Google); this page only starts the sign-in and draws what it is given.
export function UsageDashboard(props: { preview?: UsageSummary.Summary }) {
  const [state, setState] = useState<State>(props.preview ? { kind: "ready", summary: props.preview } : { kind: "loading" })

  const load = () => {
    // A refresh keeps the current numbers on screen until the new ones arrive.
    setState((current) => (current.kind === "ready" ? current : { kind: "loading" }))
    void vectorAccountClient()
      .then((client) => client.auth.getSession())
      .then(async (session) => {
        const token = session.data.session?.access_token
        if (!token) return setState({ kind: "signin", message: "Sign in with Google to see usage." })
        const response = await fetch("/api/usage/summary", {
          headers: { accept: "application/json", authorization: `Bearer ${token}` },
          cache: "no-store",
        })
        if (response.status === 401)
          return setState({ kind: "signin", message: "Your session expired. Sign in with Google again." })
        if (response.status === 403) {
          const payload = await response.json().catch(() => undefined)
          const message = payload?.error?.message
          return setState({ kind: "denied", message: typeof message === "string" ? message : "Not available." })
        }
        const summary = Option.getOrUndefined(
          decodeSummary(await readAccountApiResponse(response, "Usage counts could not load.")),
        )
        if (!summary) throw new Error("Usage counts could not load.")
        setState({ kind: "ready", summary })
      })
      .catch((cause) =>
        setState({ kind: "failed", message: cause instanceof Error ? cause.message : "Usage counts could not load." }),
      )
  }

  useEffect(() => {
    // Design-preview mode (dev-only route) renders fixtures without signing in.
    if (props.preview) return
    load()
  }, [])

  const google = (fresh: boolean) => {
    rememberAccountReturnPath("/usage")
    void vectorAccountClient()
      .then(async (client) => {
        if (fresh) await client.auth.signOut()
        const started = await client.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: `${location.origin}/account` },
        })
        if (started.error) throw started.error
      })
      .catch((cause) =>
        setState({ kind: "failed", message: cause instanceof Error ? cause.message : "Google sign-in could not start." }),
      )
  }

  if (state.kind === "ready")
    return <Dashboard summary={state.summary} onRefresh={props.preview ? () => undefined : load} />

  return (
    <div className="login-shell">
      <header className="login-top">
        <a className="login-brand" href="/" aria-label="Vector home">
          <img src="/vector-logo.png" alt="" width="26" height="26" />
          <span>Vector</span>
        </a>
      </header>
      <main className="login-main">
        <section className="auth-card" aria-labelledby="usage-title">
          <div className="auth-form-mark" aria-hidden="true">
            <img src="/vector-logo.png" alt="" width="44" height="44" />
          </div>
          <p className="auth-form-eyebrow">PRIVATE</p>
          <h1 id="usage-title">Usage</h1>
          {state.kind === "loading" && (
            <p className="auth-sub" role="status">
              Checking your session…
            </p>
          )}
          {state.kind === "signin" && (
            <>
              <p className="auth-sub">{state.message}</p>
              <button className="google-button" type="button" onClick={() => google(false)}>
                <GoogleMark /> Continue with Google
              </button>
            </>
          )}
          {state.kind === "denied" && (
            <>
              <p className="auth-sub">{state.message}</p>
              <button className="google-button" type="button" onClick={() => google(true)}>
                <GoogleMark /> Use a different Google account
              </button>
            </>
          )}
          {state.kind === "failed" && (
            <>
              <p className="auth-error usage-gate-error" role="alert">
                {state.message}
              </p>
              <button className="google-button" type="button" onClick={load}>
                Try again
              </button>
            </>
          )}
        </section>
      </main>
    </div>
  )
}

function Dashboard(props: { summary: UsageSummary.Summary; onRefresh: () => void }) {
  const totals = props.summary.totals
  const generated = new Date(props.summary.generatedAt)
  const quiet = totals.installs + totals.cliAccounts === 0

  return (
    <main className="acct usage">
      <header className="acct-header">
        <div className="acct-header-inner usage-wide">
          <a className="acct-brand" href="/" aria-label="Vector home">
            <img src="/vector-logo.png" alt="" />
            <span>Vector</span>
          </a>
          <nav aria-label="Usage navigation">
            <button type="button" onClick={props.onRefresh}>
              <RefreshCw size={14} aria-hidden="true" />
              <span className="usage-nav-label">Refresh</span>
            </button>
            <a href="/account">Account</a>
          </nav>
        </div>
      </header>

      <div className="acct-body usage-wide">
        <h1>Usage</h1>
        <p className="acct-meta">
          Counts only: installs, accounts, versions and sessions per day. Updated{" "}
          {Number.isNaN(generated.getTime()) ? "just now" : `${clock.format(generated)} UTC`}. Weeks start on Monday
          (UTC).
        </p>
        {quiet && <p className="usage-note">No check-ins recorded yet. Counts appear as apps and terminals check in.</p>}

        <section className="usage-tiles" aria-label="Headline numbers">
          <Tile label="Accounts" value={whole.format(totals.accounts)} note={`${whole.format(totals.downloadAccounts)} downloaded`} />
          <Tile label="Weekly active" value={whole.format(totals.active7)} note="last 7 days" />
          <Tile
            label="Week over week"
            value={totals.previous7 > 0 ? change.format((totals.active7 - totals.previous7) / totals.previous7) : "–"}
            note={totals.previous7 > 0 ? `from ${whole.format(totals.previous7)}` : "no earlier week yet"}
            trend={totals.previous7 > 0 ? Math.sign(totals.active7 - totals.previous7) : 0}
          />
          <Tile label="Monthly active" value={whole.format(totals.active30)} note="last 30 days" />
          <Tile
            label="Desktop installs"
            value={whole.format(totals.installs)}
            note={`${whole.format(totals.cliAccounts)} CLI accounts`}
          />
          <Tile label="Downloads" value={whole.format(totals.downloads)} note="last 13 months" />
          <Tile
            label="Sessions"
            value={whole.format(totals.sessions7)}
            note={`${whole.format(totals.subagentSessions7)} subagent, 7 days`}
          />
        </section>

        <section className="acct-section">
          <SectionHead
            title="Daily active"
            detail="Installs and CLI accounts that checked in each day, last 90 days."
            legend
          />
          <DailyChart days={props.summary.daily} />
        </section>

        <section className="acct-section">
          <SectionHead
            title="Weekly active"
            detail="People active each week. A signed-in desktop and CLI count once. The current week is still filling."
          />
          <WeeklyBars weeks={props.summary.weekly} />
        </section>

        <div className="usage-pair">
          <section className="acct-section">
            <SectionHead
              title="Retention"
              detail="Of the people first seen in a week, the share active again in each of the next four weeks."
            />
            <Retention cohorts={props.summary.retention} />
          </section>
          <section className="acct-section">
            <SectionHead
              title="Signup funnel"
              detail="Accounts created each week, and how many of them have since downloaded and used Vector."
            />
            <Funnel weeks={props.summary.funnel} />
          </section>
        </div>

        <div className="usage-pair">
          <section className="acct-section">
            <SectionHead title="Versions" detail="Latest version per install or CLI account, last 7 days." legend />
            <Breakdown
              rows={props.summary.versions.map((row) => ({
                key: `${row.client}-${row.version}`,
                client: row.client,
                label: row.version,
                active: row.active,
              }))}
            />
          </section>
          <section className="acct-section">
            <SectionHead title="Platforms" detail="Operating system and CPU, last 7 days." legend />
            <Breakdown
              rows={props.summary.platforms.map((row) => ({
                key: `${row.client}-${row.platform}-${row.arch}`,
                client: row.client,
                label: `${systemName(row.platform)} · ${row.arch}`,
                active: row.active,
              }))}
            />
          </section>
        </div>

        <section className="acct-section">
          <SectionHead title="Monthly active" detail="People active in each calendar month." />
          <MonthlyTable months={props.summary.monthly} />
        </section>
      </div>
    </main>
  )
}

function Tile(props: { label: string; value: string; note: string; trend?: number }) {
  return (
    <div className="usage-tile">
      <span className="usage-tile-label">{props.label}</span>
      <strong
        className={props.trend ? (props.trend > 0 ? "usage-tile-value usage-up" : "usage-tile-value usage-down") : "usage-tile-value"}
      >
        {props.trend ? (props.trend > 0 ? "▲ " : "▼ ") : ""}
        {props.value}
      </strong>
      <span className="usage-tile-note">{props.note}</span>
    </div>
  )
}

function SectionHead(props: { title: string; detail: string; legend?: boolean }) {
  return (
    <div className="usage-head">
      <div>
        <h2>{props.title}</h2>
        <p>{props.detail}</p>
      </div>
      {props.legend && (
        <ul className="usage-legend" aria-label="Legend">
          <li>
            <i className="usage-key usage-key-desktop" aria-hidden="true" />
            Desktop
          </li>
          <li>
            <i className="usage-key usage-key-cli" aria-hidden="true" />
            CLI
          </li>
        </ul>
      )}
    </div>
  )
}

function DailyChart(props: { days: readonly UsageSummary.Daily[] }) {
  const frame = useRef<HTMLDivElement>(null)
  const width = useWidth(frame)
  const [focus, setFocus] = useState<number | undefined>()
  const height = 220
  const inset = { top: 14, right: 64, bottom: 26, left: 40 }
  const plotWidth = Math.max(1, width - inset.left - inset.right)
  const plotHeight = height - inset.top - inset.bottom
  const top = niceCeiling(Math.max(1, ...props.days.flatMap((day) => [day.desktop, day.cli])))
  const step = props.days.length > 1 ? plotWidth / (props.days.length - 1) : 0
  const x = (index: number) => inset.left + index * step
  const y = (value: number) => inset.top + plotHeight - (value / top) * plotHeight
  const line = (pick: (day: UsageSummary.Daily) => number) =>
    props.days.map((day, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(pick(day)).toFixed(1)}`).join("")
  const last = props.days.at(-1)
  const lastIndex = props.days.length - 1
  // End labels only while they cannot collide; the legend always carries identity.
  const labelled = last && Math.abs(y(last.desktop) - y(last.cli)) >= 14
  const hovered = focus === undefined ? undefined : props.days[focus]
  const ticks = top % 2 === 0 ? [0, top / 2, top] : [0, top]
  const marks = props.days.length ? [0, Math.floor(lastIndex / 2), lastIndex] : []

  return (
    <div className="usage-chart" ref={frame}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Daily active installs and CLI accounts, last ${props.days.length} days`}
          onPointerLeave={() => setFocus(undefined)}
          onPointerMove={(event) => {
            if (!step) return
            const left = event.currentTarget.getBoundingClientRect().left
            setFocus(Math.min(lastIndex, Math.max(0, Math.round((event.clientX - left - inset.left) / step))))
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="usage-grid" x1={inset.left} x2={inset.left + plotWidth} y1={y(tick)} y2={y(tick)} />
              <text className="usage-axis" x={inset.left - 8} y={y(tick) + 4} textAnchor="end">
                {whole.format(tick)}
              </text>
            </g>
          ))}
          {marks.map((index) => (
            <text
              key={index}
              className="usage-axis"
              x={x(index)}
              y={height - 6}
              textAnchor={index === 0 ? "start" : index === lastIndex ? "end" : "middle"}
            >
              {shortDay.format(utc(props.days[index]?.day))}
            </text>
          ))}
          <path className="usage-line usage-line-desktop" d={line((day) => day.desktop)} />
          <path className="usage-line usage-line-cli" d={line((day) => day.cli)} />
          {last && (
            <>
              <circle className="usage-dot usage-dot-desktop" cx={x(lastIndex)} cy={y(last.desktop)} r={4} />
              <circle className="usage-dot usage-dot-cli" cx={x(lastIndex)} cy={y(last.cli)} r={4} />
            </>
          )}
          {last && labelled && (
            <>
              <text className="usage-end" x={x(lastIndex) + 9} y={y(last.desktop) + 4}>
                Desktop {whole.format(last.desktop)}
              </text>
              <text className="usage-end" x={x(lastIndex) + 9} y={y(last.cli) + 4}>
                CLI {whole.format(last.cli)}
              </text>
            </>
          )}
          {hovered && focus !== undefined && (
            <>
              <line className="usage-crosshair" x1={x(focus)} x2={x(focus)} y1={inset.top} y2={inset.top + plotHeight} />
              <circle className="usage-dot usage-dot-desktop" cx={x(focus)} cy={y(hovered.desktop)} r={4} />
              <circle className="usage-dot usage-dot-cli" cx={x(focus)} cy={y(hovered.cli)} r={4} />
            </>
          )}
        </svg>
      )}
      {hovered && focus !== undefined && (
        <div
          className="usage-tooltip"
          // Beside the crosshair, on the side with room, so it never covers the point it describes.
          style={{
            left: x(focus),
            transform: x(focus) > width / 2 ? "translateX(calc(-100% - 14px))" : "translateX(14px)",
          }}
          role="status"
        >
          <b>{longDay.format(utc(hovered.day))}</b>
          <span>
            <i className="usage-key usage-key-desktop" aria-hidden="true" /> Desktop {whole.format(hovered.desktop)}
          </span>
          <span>
            <i className="usage-key usage-key-cli" aria-hidden="true" /> CLI {whole.format(hovered.cli)}
          </span>
          <span>People {whole.format(hovered.active)}</span>
          <span>
            Sessions {whole.format(hovered.sessions)} · subagent {whole.format(hovered.subagentSessions)}
          </span>
        </div>
      )}
      <details className="usage-table-toggle">
        <summary>Show as a table</summary>
        <Scroll>
          <table className="usage-table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">People</th>
                <th scope="col">Desktop</th>
                <th scope="col">CLI</th>
                <th scope="col">Sessions</th>
                <th scope="col">Subagent</th>
              </tr>
            </thead>
            <tbody>
              {[...props.days].reverse().map((day) => (
                <tr key={day.day}>
                  <th scope="row">{longDay.format(utc(day.day))}</th>
                  <td>{whole.format(day.active)}</td>
                  <td>{whole.format(day.desktop)}</td>
                  <td>{whole.format(day.cli)}</td>
                  <td>{whole.format(day.sessions)}</td>
                  <td>{whole.format(day.subagentSessions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      </details>
    </div>
  )
}

function WeeklyBars(props: { weeks: readonly UsageSummary.Weekly[] }) {
  const [focus, setFocus] = useState<string | undefined>()
  const strip = useRef<HTMLDivElement>(null)
  const top = Math.max(1, ...props.weeks.map((week) => week.active))
  const current = props.weeks.at(-1)?.week
  const hovered = props.weeks.find((week) => week.week === focus)

  // On a narrow screen the strip scrolls; start at the latest weeks, which matter most.
  useEffect(() => {
    if (strip.current) strip.current.scrollLeft = strip.current.scrollWidth
  }, [])

  return (
    <div className="usage-weekly">
      <div className="usage-scroll" ref={strip}>
        <ol className="usage-bars" aria-label="Weekly active people">
          {props.weeks.map((week, index) => (
            <li
              key={week.week}
              className={week.week === current ? "usage-bar usage-bar-partial" : "usage-bar"}
              tabIndex={0}
              onPointerEnter={() => setFocus(week.week)}
              onPointerLeave={() => setFocus(undefined)}
              onFocus={() => setFocus(week.week)}
              onBlur={() => setFocus(undefined)}
              aria-label={`Week of ${longDay.format(utc(week.week))}: ${whole.format(week.active)} active${week.week === current ? " so far" : week.growth === null ? "" : `, ${change.format(week.growth)} on the week before`}`}
            >
              <span className="usage-bar-value">{whole.format(week.active)}</span>
              <span className="usage-bar-track">
                <span className="usage-bar-fill" style={{ height: `${(week.active / top) * 100}%` }} />
              </span>
              {/* A week still filling would always look like a fall, so it shows no growth yet. */}
              <span
                className={
                  week.week === current || week.growth === null || week.growth === 0
                    ? "usage-bar-growth"
                    : week.growth > 0
                      ? "usage-bar-growth usage-up"
                      : "usage-bar-growth usage-down"
                }
              >
                {week.week === current ? "so far" : week.growth === null ? "–" : change.format(week.growth)}
              </span>
              <span className="usage-bar-label">
                {(props.weeks.length - 1 - index) % 4 === 0 ? shortDay.format(utc(week.week)) : ""}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <p className="usage-caption" aria-live="polite">
        {hovered
          ? `Week of ${longDay.format(utc(hovered.week))}${hovered.week === current ? " (so far)" : ""}: ${whole.format(hovered.active)} people, ${whole.format(hovered.desktop)} desktop installs, ${whole.format(hovered.cli)} CLI accounts${hovered.week === current || hovered.growth === null ? "" : `, ${change.format(hovered.growth)} on the week before`}.`
          : "Growth under each bar compares a week with the one before. Point at a week for its detail."}
      </p>
    </div>
  )
}

function Retention(props: { cohorts: readonly UsageSummary.Cohort[] }) {
  return (
    <Scroll>
      <table className="usage-table usage-retention">
        <thead>
          <tr>
            <th scope="col">First seen</th>
            <th scope="col">People</th>
            {[1, 2, 3, 4].map((week) => (
              <th scope="col" key={week}>
                Week {week}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...props.cohorts].reverse().map((cohort) => (
            <tr key={cohort.cohort}>
              <th scope="row">{shortDay.format(utc(cohort.cohort))}</th>
              <td>{whole.format(cohort.size)}</td>
              {cohort.weeks.map((share, index) => (
                <td
                  key={index}
                  className={share === null ? "usage-cell-empty" : "usage-cell"}
                  style={share === null ? undefined : { background: `rgba(154, 124, 240, ${0.06 + share * 0.5})` }}
                >
                  {share === null ? "–" : percent.format(share)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  )
}

function Funnel(props: { weeks: readonly UsageSummary.Funnel[] }) {
  const share = (part: number, total: number) => (total ? percent.format(part / total) : "–")
  const sum = (pick: (week: UsageSummary.Funnel) => number) => props.weeks.reduce((total, week) => total + pick(week), 0)
  const signups = sum((week) => week.signups)
  const downloaded = sum((week) => week.downloaded)
  const active = sum((week) => week.active)

  return (
    <Scroll>
      <table className="usage-table usage-funnel">
        <thead>
          <tr>
            <th scope="col">Signed up</th>
            <th scope="col">Accounts</th>
            <th scope="col">Downloaded</th>
            <th scope="col">Used Vector</th>
          </tr>
        </thead>
        <tbody>
          {[...props.weeks].reverse().map((week) => (
            <tr key={week.week}>
              <th scope="row">{shortDay.format(utc(week.week))}</th>
              <td>{whole.format(week.signups)}</td>
              <td>
                {whole.format(week.downloaded)} <small>{share(week.downloaded, week.signups)}</small>
              </td>
              <td>
                {whole.format(week.active)} <small>{share(week.active, week.signups)}</small>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{props.weeks.length} weeks</th>
            <td>{whole.format(signups)}</td>
            <td>
              {whole.format(downloaded)} <small>{share(downloaded, signups)}</small>
            </td>
            <td>
              {whole.format(active)} <small>{share(active, signups)}</small>
            </td>
          </tr>
        </tfoot>
      </table>
    </Scroll>
  )
}

function Breakdown(props: { rows: { key: string; client: "desktop" | "cli"; label: string; active: number }[] }) {
  const top = Math.max(1, ...props.rows.map((row) => row.active))
  if (!props.rows.length) return <p className="usage-empty">Nothing in the last 7 days.</p>
  return (
    <ul className="usage-breakdown">
      {props.rows.map((row) => (
        <li key={row.key}>
          <span className="usage-breakdown-label">
            <i className={`usage-key usage-key-${row.client}`} aria-hidden="true" />
            <span className="usage-visually-hidden">{row.client === "cli" ? "CLI" : "Desktop"} </span>
            {row.label}
          </span>
          <span className="usage-breakdown-track" aria-hidden="true">
            <span className={`usage-breakdown-fill usage-fill-${row.client}`} style={{ width: `${(row.active / top) * 100}%` }} />
          </span>
          <span className="usage-breakdown-value">{whole.format(row.active)}</span>
        </li>
      ))}
    </ul>
  )
}

function MonthlyTable(props: { months: readonly { month: string; active: number }[] }) {
  return (
    <Scroll>
      <table className="usage-table usage-months">
        <thead>
          <tr>
            {props.months.map((month) => (
              <th scope="col" key={month.month}>
                {monthName.format(utc(month.month))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            {props.months.map((month) => (
              <td key={month.month}>{whole.format(month.active)}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </Scroll>
  )
}

// Wide tables and the weekly bars scroll inside their card on a phone, never the page.
function Scroll(props: { children: ReactNode }) {
  return <div className="usage-scroll">{props.children}</div>
}

function useWidth(target: { current: HTMLElement | null }) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!target.current) return
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0]?.contentRect.width ?? 0)))
    observer.observe(target.current)
    return () => observer.disconnect()
  }, [])
  return width
}

/** 1, 2 or 5 times a power of ten, so the axis reads in round numbers. */
function niceCeiling(value: number) {
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 5, 10].find((multiple) => multiple * power >= value) ?? 10
  return Math.max(2, step * power)
}

function utc(day: string | undefined) {
  return new Date(`${day ?? "1970-01-01"}T00:00:00Z`)
}

function systemName(platform: string) {
  if (platform === "darwin") return "macOS"
  if (platform === "win32") return "Windows"
  if (platform === "linux") return "Linux"
  return platform
}
