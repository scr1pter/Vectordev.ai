import { createEffect, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { vercelApi, vercelErrorText, type VercelDeployment } from "./vercel-api"
import { formatWhen, VercelLinkRequired, type VercelNotice } from "./vercel-ui"

// Build output and the running app's logs for any deployment of the linked
// Vercel project, the same reads the agent's logs action makes.
export function VercelLogs(props: { projectPath: string; notice: VercelNotice; onOpenConnections?: () => void }) {
  const api = vercelApi()
  const [state, setState] = createStore({
    linked: true,
    deployments: [] as VercelDeployment[],
    selected: "",
    source: "runtime" as "build" | "runtime",
    output: "",
    fetchedAt: "",
    loading: false,
  })

  createEffect(
    on(
      () => props.projectPath,
      async () => {
        if (!api || !props.projectPath) return
        setState("output", "")
        const status = await api.status(props.projectPath).catch(() => undefined)
        setState("linked", Boolean(status?.link))
        if (!status?.link) return
        const listed = await api.deployments(props.projectPath, 30).catch((caught) => {
          props.notice({ tone: "error", text: vercelErrorText(caught, "Could not list deployments.") })
          return []
        })
        setState({ deployments: listed, selected: (listed.find((item) => item.current) ?? listed[0])?.id ?? "" })
      },
    ),
  )

  const read = async () => {
    if (!api || !state.selected) return
    setState("loading", true)
    try {
      const result = await api.logs(props.projectPath, state.selected, state.source, 300)
      setState({
        fetchedAt: result.fetchedAt,
        output:
          result.log ||
          (state.source === "runtime"
            ? "No runtime output arrived in the few seconds Vector listened. Use the app, then read again."
            : "This deployment printed no build output."),
      })
    } catch (caught) {
      setState("output", "")
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not read the logs.") })
    } finally {
      setState("loading", false)
    }
  }

  return (
    <VercelLinkRequired linked={state.linked} onOpenConnections={props.onOpenConnections}>
      <div class="cloud-panel vercel-section">
        <div class="vercel-log-controls">
          <select class="cloud-input" value={state.selected} onChange={(event) => setState("selected", event.currentTarget.value)}>
            <For each={state.deployments} fallback={<option value="">No deployments yet</option>}>
              {(deployment) => (
                <option value={deployment.id}>
                  {deployment.current ? "Production · " : `${deployment.target} · `}
                  {deployment.branch ? `${deployment.branch} · ` : ""}
                  {formatWhen(deployment.createdAt)} · {deployment.state.toLowerCase()}
                </option>
              )}
            </For>
          </select>
          <div class="cloud-segment" aria-label="Log source">
            <button type="button" data-active={state.source === "runtime"} onClick={() => setState("source", "runtime")}>
              Runtime
            </button>
            <button type="button" data-active={state.source === "build"} onClick={() => setState("source", "build")}>
              Build
            </button>
          </div>
          <button class="cloud-button" data-variant="primary" type="button" disabled={!state.selected || state.loading} onClick={() => void read()}>
            {state.loading ? "Reading…" : "Read logs"}
          </button>
        </div>
        <Show when={state.output}>
          <p class="cloud-muted mt-3 text-[11px]">
            {state.source === "runtime" ? "Requests, errors and console output of the running app" : "What the build printed"} · read{" "}
            {formatWhen(state.fetchedAt)}
          </p>
          <pre class="cloud-log mt-2">{state.output}</pre>
        </Show>
      </div>
    </VercelLinkRequired>
  )
}
