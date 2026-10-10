import "./cloud-session-card.css"
import { useNavigate } from "@solidjs/router"
import { Popover } from "@vectordevai/ui/popover"
import { createMemo, createSignal, For, Show, splitProps, type ComponentProps } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { cloudApi, type CloudReleaseSummary } from "./cloud-api"
import {
  cloudHref,
  cloudStatus,
  currentFailure,
  DATABASE_SETUP_PROMPT,
  deploymentEvidence,
  deployRepairPrompt,
  requestComposerPrompt,
} from "./cloud-handoff"
import type { CloudSection } from "./cloud-console"
import { createCloudOverview } from "./cloud-overview"

const RELEASE_LABELS: Record<CloudReleaseSummary["releaseStatus"], string> = {
  preview: "Preview",
  current: "Live in production",
  superseded: "Replaced in production",
  "rolled-back": "Rolled back",
}

const HEALTH_LABELS: Record<CloudReleaseSummary["status"], string> = {
  ready: "healthy",
  degraded: "degraded",
  unreachable: "unreachable",
  unknown: "health not checked yet",
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path

const formatTime = (value: string) =>
  new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

/**
 * The session header's Cloud button. Its card shows this project's Vercel
 * hosting, Supabase database and latest release, and refreshes whenever cloud
 * state changes, whoever changed it: a Cloud screen, the preview's Publish, or
 * the agent.
 */
export function CloudSessionButton() {
  const api = cloudApi()
  return <Show when={api}>{(current) => <CloudSessionCard api={current()} />}</Show>
}

function CloudSessionCard(props: { api: NonNullable<ReturnType<typeof cloudApi>> }) {
  const sdk = useSDK()
  const navigate = useNavigate()
  const platform = usePlatform()
  const server = useServer()
  const tabs = useTabs()
  const [open, setOpen] = createSignal(false)
  const [fixing, setFixing] = createSignal(false)
  const cloud = createCloudOverview({ api: props.api, directory: () => sdk().directory })
  const overview = cloud.overview
  const status = createMemo(() => cloudStatus(overview()))
  const failure = createMemo(() => {
    const current = overview()
    return current ? currentFailure(current) : undefined
  })
  const needsFix = createMemo(() => Boolean(failure() || overview()?.latest?.failedChecks.length))

  const openCloud = (section?: CloudSection) => {
    setOpen(false)
    navigate(cloudHref(overview()?.projectPath, section))
  }

  // The session on screen takes the prompt; a new session on the project is
  // the fallback when no composer is mounted.
  const ask = (text: string) => {
    setOpen(false)
    if (requestComposerPrompt({ text, send: true })) return
    const project = overview()?.projectPath
    if (project) tabs.newDraft({ server: server.key, directory: project }, text, { send: true })
  }

  const fixDeploy = async () => {
    const current = overview()
    if (!current) return
    const failed = failure()
    if (failed) {
      ask(
        deployRepairPrompt({
          project: basename(current.projectPath),
          environment: failed.environment,
          error: failed.error,
          git: current.git,
          checks: failed.checks,
          log: failed.log,
        }),
      )
      return
    }
    const latest = current.latest
    if (!latest) return
    setFixing(true)
    const deployment = await props.api.deployments
      .list(current.projectPath)
      .then((items) => items.find((item) => item.id === latest.id))
      .catch(() => undefined)
      .finally(() => setFixing(false))
    if (!deployment) {
      cloud.setError("That release is no longer in this project's history.")
      return
    }
    ask(deployRepairPrompt(deploymentEvidence(deployment)))
  }

  return (
    <Popover
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void cloud.refresh()
      }}
      triggerAs={HeaderTool}
      triggerProps={{
        type: "button",
        class: "vx-cloud-launch",
        active: open(),
        "aria-label": `Vector Cloud: ${status().label}`,
        title: `Vector Cloud: ${status().label}`,
      }}
      trigger={
        <>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4.35 12.2a2.9 2.9 0 0 1-.3-5.78 3.6 3.6 0 0 1 6.96-1.2 2.7 2.7 0 0 1 .54 5.34"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
          <span>Cloud</span>
          <i class="vx-cloud-dot" data-tone={status().tone} aria-hidden="true" />
        </>
      }
      class="vx-cloud-popover"
      gutter={6}
      placement="bottom-end"
    >
      <div class="vx-cloud-card" data-vector-cloud-card>
        <header>
          <strong>Vector Cloud</strong>
          <span>
            {overview() ? basename(overview()!.projectPath) : basename(sdk().directory)}
            <Show when={overview()?.workspace}>{(workspace) => ` · agent workspace ${workspace().name}`}</Show>
          </span>
        </header>
        <Show when={cloud.error()}>
          <p class="vx-cloud-card__error" role="alert">
            {cloud.error()}
          </p>
        </Show>
        <Show when={overview()} fallback={<p class="vx-cloud-card__muted">Checking this project…</p>}>
          {(current) => (
            <>
              <section class="vx-cloud-card__row">
                <i
                  class="vx-cloud-dot"
                  data-tone={
                    current().hosting.project ? "success" : current().hosting.connected ? "warning" : undefined
                  }
                />
                <div>
                  <strong>Hosting · Vercel</strong>
                  <small>
                    {current().hosting.connected
                      ? current().hosting.project
                        ? `${current().hosting.account ? `${current().hosting.account} · ` : ""}project ${current().hosting.project!.name}`
                        : "Connected, but no Vercel project is linked to this project"
                      : "Not connected"}
                  </small>
                </div>
                <Show when={!current().hosting.project}>
                  <button type="button" onClick={() => openCloud("connections")}>
                    Set up
                  </button>
                </Show>
              </section>

              <section class="vx-cloud-card__row">
                <i class="vx-cloud-dot" data-tone={current().database.connected ? "success" : undefined} />
                <div>
                  <strong>Database · Supabase</strong>
                  <small>
                    {current().database.connected
                      ? current().database.name
                      : current().database.accountConnected
                        ? "Account connected, but no project is linked"
                        : "No database yet"}
                  </small>
                </div>
                <Show when={!current().database.connected}>
                  <button type="button" onClick={() => ask(DATABASE_SETUP_PROMPT)}>
                    Ask Vector to set it up
                  </button>
                </Show>
              </section>

              <section class="vx-cloud-card__row">
                <i
                  class="vx-cloud-dot"
                  data-tone={
                    current().latest?.failedChecks.length || current().latest?.status === "unreachable"
                      ? "error"
                      : current().latest
                        ? "success"
                        : undefined
                  }
                />
                <div>
                  <strong>Latest release</strong>
                  <Show when={current().latest} fallback={<small>Nothing published yet</small>}>
                    {(latest) => (
                      <>
                        <small>
                          {RELEASE_LABELS[latest().releaseStatus]} · {HEALTH_LABELS[latest().status]} ·{" "}
                          {formatTime(latest().createdAt)}
                        </small>
                        <button
                          type="button"
                          class="vx-cloud-card__link"
                          onClick={() => platform.openLink(latest().url)}
                        >
                          {latest().url}
                        </button>
                        <Show when={latest().failedChecks.length}>
                          <small class="vx-cloud-card__failed">
                            Failed:{" "}
                            {latest()
                              .failedChecks.map((check) => check.label)
                              .join(", ")}
                          </small>
                        </Show>
                      </>
                    )}
                  </Show>
                  <Show when={current().production && current().production!.id !== current().latest?.id}>
                    <small>
                      Production ({HEALTH_LABELS[current().production!.status]}):{" "}
                      <button
                        type="button"
                        class="vx-cloud-card__link"
                        onClick={() => platform.openLink(current().production!.url)}
                      >
                        {current().production!.url}
                      </button>
                    </small>
                  </Show>
                </div>
              </section>

              <Show when={failure()}>
                {(failed) => (
                  <section class="vx-cloud-card__alert">
                    <strong>Last publish failed · {formatTime(failed().at)}</strong>
                    <small>{failed().error}</small>
                    <For each={failed().checks}>
                      {(check) => (
                        <small>
                          {check.label}: {check.details ?? "failed"}
                        </small>
                      )}
                    </For>
                  </section>
                )}
              </Show>

              <footer>
                <Show when={needsFix()}>
                  <button type="button" data-variant="primary" disabled={fixing()} onClick={() => void fixDeploy()}>
                    {fixing() ? "Gathering evidence…" : "Fix this deploy"}
                  </button>
                </Show>
                <button type="button" onClick={() => openCloud()}>
                  Open Vector Cloud
                </button>
              </footer>
            </>
          )}
        </Show>
      </div>
    </Popover>
  )
}

// A session header tool button, so the Cloud button sits with Changes and
// Terminal in the same style. The popover trigger passes its own props through.
function HeaderTool(props: ComponentProps<"button"> & { active?: boolean }) {
  const [local, rest] = splitProps(props, ["active"])
  return <button data-vector-session-tool data-active={local.active ? "true" : "false"} {...rest} />
}
