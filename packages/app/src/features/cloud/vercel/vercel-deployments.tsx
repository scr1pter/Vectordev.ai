import { createEffect, createMemo, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { cloudApi, type CloudDeployment } from "../cloud-api"
import { deployRepairPrompt } from "../cloud-handoff"
import { vercelApi, vercelErrorText, type VercelDeployment, type VercelProjectStatus } from "./vercel-api"
import { deploymentActions, deploymentTone, matchRelease, rollbackTarget, type DeploymentAction } from "./vercel-model"
import { createConfirm, formatWhen, VercelLinkRequired, type VercelNotice } from "./vercel-ui"

type LogView = { id: string; source: "build" | "runtime"; text: string; fetchedAt?: string; loading: boolean }

// Every deployment Vercel has for the linked project, git pushes included,
// with Vector's own release checks attached where Vector made it.
export function VercelDeployments(props: {
  projectPath: string
  notice: VercelNotice
  refreshKey?: number
  /** Starts the agent on a failed deployment, with `prompt` (redacted evidence) as its first message. */
  onRepair: (prompt: string) => void
  onOpenConnections?: () => void
}) {
  const api = vercelApi()
  const cloud = cloudApi()
  const platform = usePlatform()
  const confirm = createConfirm()
  const [state, setState] = createStore({
    status: undefined as VercelProjectStatus | undefined,
    deployments: [] as VercelDeployment[],
    releases: [] as CloudDeployment[],
    loading: false,
    busy: "",
    expanded: "",
    logs: undefined as LogView | undefined,
  })
  const current = createMemo(() => state.deployments.find((item) => item.current))
  const previous = createMemo(() => rollbackTarget(state.deployments, current(), state.releases))

  const load = async () => {
    if (!api || !props.projectPath) return
    setState("loading", true)
    try {
      const nextStatus = await api.status(props.projectPath)
      setState("status", nextStatus)
      if (!nextStatus.link) {
        setState("deployments", [])
        return
      }
      const [nextDeployments, nextReleases] = await Promise.all([
        api.deployments(props.projectPath, 30),
        cloud?.deployments.list(props.projectPath).catch(() => []) ?? Promise.resolve([]),
      ])
      setState({ deployments: nextDeployments, releases: nextReleases })
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not read Vercel deployments.") })
    } finally {
      setState("loading", false)
    }
  }

  createEffect(
    on(
      () => [props.projectPath, props.refreshKey],
      () => void load(),
    ),
  )

  const act = async (deployment: VercelDeployment, action: DeploymentAction) => {
    if (!api) return
    setState("busy", `${action}-${deployment.id}`)
    try {
      if (action === "cancel") {
        await api.cancel(props.projectPath, deployment.id)
        props.notice({ tone: "info", text: `Canceled ${deployment.id}.` })
      }
      if (action === "redeploy") {
        const result = await api.redeploy(props.projectPath, deployment.id)
        props.notice({
          tone: "success",
          text: `Rebuilding as ${result.deployment.id}${result.deployment.target === "production" ? ". Production stays where it is until you promote the new build." : "."}`,
        })
      }
      if (action === "promote") {
        const result = await api.promote(props.projectPath, deployment.id)
        props.notice({ tone: "success", text: `Production now serves ${result.productionUrl ?? deployment.url}.` })
      }
      if (action === "rollback") {
        const result = await api.rollback(props.projectPath, deployment.id)
        props.notice({
          tone: "success",
          text: `Production rolled back to ${result.deployment.id}. Vercel keeps it there until you promote another deployment.`,
        })
      }
      await load()
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Vercel did not accept that change.") })
    } finally {
      setState("busy", "")
    }
  }

  // The target shown on the button is the one rolled back to.
  const rollbackPrevious = async (target: VercelDeployment) => {
    if (!api) return
    setState("busy", "rollback-previous")
    try {
      const result = await api.rollback(props.projectPath, target.id)
      props.notice({ tone: "success", text: `Production rolled back to ${result.deployment.url}.` })
      await load()
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not roll back.") })
    } finally {
      setState("busy", "")
    }
  }

  const readLogs = async (deployment: VercelDeployment, source: "build" | "runtime") => {
    if (!api) return
    setState("logs", { id: deployment.id, source, text: "", loading: true })
    try {
      const result = await api.logs(props.projectPath, deployment.id, source)
      setState("logs", {
        id: deployment.id,
        source,
        loading: false,
        fetchedAt: result.fetchedAt,
        text:
          result.log ||
          (source === "runtime"
            ? "No runtime output arrived in the few seconds Vector listened. Open the app, then read again."
            : "This deployment has no build output."),
      })
    } catch (caught) {
      setState("logs", {
        id: deployment.id,
        source,
        loading: false,
        text: vercelErrorText(caught, "Could not read logs."),
      })
    }
  }

  const rerunChecks = async (release: CloudDeployment) => {
    if (!cloud) return
    setState("busy", `checks-${release.id}`)
    try {
      const updated = await cloud.deployments.rerunChecks(props.projectPath, undefined, release.id)
      setState("releases", (items) => items.map((item) => (item.id === updated.id ? updated : item)))
      const failed = updated.checks.filter((check) => check.required && check.status === "failed").length
      props.notice({
        tone: failed ? "error" : "success",
        text: failed
          ? `${failed} required check${failed === 1 ? "" : "s"} failed.`
          : "All required release checks passed.",
      })
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not run the release checks.") })
    } finally {
      setState("busy", "")
    }
  }

  // Check output and logs arrive from the desktop already redacted. The
  // deployment id lets the agent read the logs this screen has not loaded.
  const repair = (deployment: VercelDeployment, release?: CloudDeployment) =>
    props.onRepair(
      deployRepairPrompt({
        project: state.status?.link?.projectName ?? "this project",
        environment: deployment.target === "production" ? "production" : "preview",
        url: deployment.url,
        deploymentId: deployment.id,
        error: deployment.errorMessage ? `Vercel reported: ${deployment.errorMessage}` : undefined,
        git: deployment.branch
          ? { branch: deployment.branch, commit: deployment.commitSha?.slice(0, 8) ?? "unknown", dirty: false }
          : undefined,
        checks: release?.checks ?? [],
        log: state.logs?.id === deployment.id ? state.logs.text : undefined,
      }),
    )

  // A production rebuild does not take production's domains; the confirm says so.
  const actionLabel = (action: DeploymentAction, deployment: VercelDeployment) => {
    if (confirm.armed(`${action}-${deployment.id}`)) {
      if (action === "redeploy" && deployment.target === "production") return "Confirm rebuild? Production stays put"
      return `Confirm ${action === "rollback" ? "roll back" : action}?`
    }
    if (action === "rollback") return "Roll back to this"
    return action === "cancel" ? "Cancel build" : action === "promote" ? "Promote" : "Redeploy"
  }

  return (
    <div class="cloud-panel vercel-section">
      <div class="vercel-section-head">
        <div>
          <div class="cloud-panel-title">Vercel deployments</div>
          <p class="cloud-muted mt-1 text-[12px]">
            {state.status?.link
              ? `Everything ${state.status.link.projectName} has deployed, from Vector, the CLI or git pushes.`
              : "Every deployment of the linked Vercel project, including git pushes."}
          </p>
        </div>
        <div class="vercel-actions">
          <Show when={previous()}>
            {(target) => (
              <button
                class="cloud-button"
                data-variant="warning"
                type="button"
                disabled={Boolean(state.busy)}
                onClick={() => confirm.request("rollback-previous", () => void rollbackPrevious(target()))}
              >
                {confirm.armed("rollback-previous") ? `Confirm roll back to ${target().id}?` : "Roll back production"}
              </button>
            )}
          </Show>
          <button class="cloud-button" type="button" disabled={state.loading} onClick={() => void load()}>
            {state.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      <VercelLinkRequired
        linked={Boolean(state.status?.link) || !state.status}
        onOpenConnections={props.onOpenConnections}
      >
        <div class="cloud-list mt-3">
          <For
            each={state.deployments}
            fallback={
              <p class="cloud-muted text-[12px]">
                {state.loading ? "Loading…" : "No deployments yet. Publish a preview to create one."}
              </p>
            }
          >
            {(deployment) => {
              const release = () => matchRelease(deployment, state.releases)
              const failedChecks = () =>
                release()?.checks.filter((check) => check.required && check.status === "failed") ?? []
              const actions = () => deploymentActions(deployment, current(), release())
              return (
                <div class="cloud-row cloud-row-block">
                  <div class="min-w-0 flex-1">
                    <div class="vercel-row-head">
                      <span class="cloud-status" data-tone={deploymentTone(deployment)}>
                        {deployment.state.toLowerCase()}
                      </span>
                      <span class="cloud-status" data-tone={deployment.current ? "success" : undefined}>
                        {deployment.current ? "serving production" : deployment.target}
                      </span>
                      <Show when={deployment.source}>
                        <span class="cloud-status">{deployment.source === "git" ? "git push" : deployment.source}</span>
                      </Show>
                      <Show when={release()}>
                        <span class="cloud-status" data-tone={failedChecks().length ? "error" : "success"}>
                          {failedChecks().length
                            ? `${failedChecks().length} Vector check(s) failed`
                            : "Vector checks passed"}
                        </span>
                      </Show>
                    </div>
                    <a class="cloud-link" href={deployment.url} target="_blank" rel="noopener noreferrer">
                      {deployment.url.replace(/^https:\/\//, "")}
                    </a>
                    <Show when={deployment.branch}>
                      <p class="cloud-git-line">
                        <span>{deployment.branch}</span>
                        <Show when={deployment.commitSha}>
                          <code>{deployment.commitSha?.slice(0, 7)}</code>
                        </Show>
                        <Show when={deployment.commitMessage}>
                          <span>{deployment.commitMessage?.split("\n")[0]}</span>
                        </Show>
                      </p>
                    </Show>
                    <p class="cloud-muted text-[11px]">
                      {formatWhen(deployment.createdAt)}
                      {deployment.creator ? ` · ${deployment.creator}` : ""} · <code>{deployment.id}</code>
                    </p>
                    <Show when={deployment.errorMessage}>
                      <p class="vercel-warning text-[11.5px]">{deployment.errorMessage}</p>
                    </Show>
                    <Show when={state.expanded === deployment.id}>
                      <div class="vercel-detail">
                        <Show when={deployment.aliases.length}>
                          <p>
                            Addresses:{" "}
                            <For each={deployment.aliases}>
                              {(alias) => (
                                <a
                                  class="cloud-link"
                                  href={`https://${alias}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {alias}{" "}
                                </a>
                              )}
                            </For>
                          </p>
                        </Show>
                        <Show when={deployment.inspectorUrl}>
                          {(url) => (
                            <button class="vercel-text-button" type="button" onClick={() => platform.openLink(url())}>
                              Open in Vercel
                            </button>
                          )}
                        </Show>
                        <Show when={release()}>
                          {(item) => (
                            <div class="cloud-check-list">
                              <For each={item().checks} fallback={<p>No release checks recorded.</p>}>
                                {(check) => (
                                  <div class="cloud-check" data-status={check.status}>
                                    <span class="cloud-check-mark">
                                      {check.status === "passed" ? "✓" : check.status === "failed" ? "!" : "–"}
                                    </span>
                                    <div>
                                      <strong>{check.label}</strong>
                                      <p>{check.details ?? check.status}</p>
                                      <Show when={check.output}>
                                        <pre>{check.output}</pre>
                                      </Show>
                                    </div>
                                  </div>
                                )}
                              </For>
                            </div>
                          )}
                        </Show>
                      </div>
                    </Show>
                    <Show when={state.logs?.id === deployment.id}>
                      <div class="vercel-detail">
                        <div class="cloud-segment" aria-label="Log source">
                          <button
                            type="button"
                            data-active={state.logs?.source === "build"}
                            onClick={() => void readLogs(deployment, "build")}
                          >
                            Build
                          </button>
                          <button
                            type="button"
                            data-active={state.logs?.source === "runtime"}
                            onClick={() => void readLogs(deployment, "runtime")}
                          >
                            Runtime
                          </button>
                        </div>
                        <pre class="cloud-log mt-2">
                          {state.logs?.loading ? "Reading from Vercel…" : state.logs?.text}
                        </pre>
                      </div>
                    </Show>
                  </div>
                  <div class="cloud-deployment-actions">
                    <button
                      class="cloud-button"
                      type="button"
                      onClick={() => setState("expanded", (value) => (value === deployment.id ? "" : deployment.id))}
                    >
                      {state.expanded === deployment.id ? "Hide details" : "Details"}
                    </button>
                    <button
                      class="cloud-button"
                      type="button"
                      onClick={() =>
                        state.logs?.id === deployment.id
                          ? setState("logs", undefined)
                          : void readLogs(deployment, deployment.state === "READY" ? "runtime" : "build")
                      }
                    >
                      {state.logs?.id === deployment.id ? "Hide logs" : "Logs"}
                    </button>
                    <For each={actions()}>
                      {(action) => (
                        <button
                          class="cloud-button"
                          data-variant={
                            action === "promote"
                              ? "primary"
                              : action === "rollback" || action === "cancel"
                                ? "warning"
                                : undefined
                          }
                          type="button"
                          disabled={Boolean(state.busy)}
                          onClick={() =>
                            confirm.request(`${action}-${deployment.id}`, () => void act(deployment, action))
                          }
                        >
                          {state.busy === `${action}-${deployment.id}` ? "Working…" : actionLabel(action, deployment)}
                        </button>
                      )}
                    </For>
                    <Show when={release()}>
                      {(item) => (
                        <button
                          class="cloud-button"
                          type="button"
                          disabled={Boolean(state.busy)}
                          onClick={() => void rerunChecks(item())}
                        >
                          {state.busy === `checks-${item().id}` ? "Checking…" : "Run checks"}
                        </button>
                      )}
                    </Show>
                    <Show when={deployment.state === "ERROR" || failedChecks().length}>
                      <button
                        class="cloud-button"
                        data-variant="primary"
                        type="button"
                        onClick={() => repair(deployment, release())}
                      >
                        Fix this deploy
                      </button>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </VercelLinkRequired>
    </div>
  )
}
