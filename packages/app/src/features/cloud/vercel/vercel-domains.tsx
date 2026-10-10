import { createEffect, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { vercelApi, vercelErrorText, type VercelDomain } from "./vercel-api"
import { domainStatusLabel, domainStatusTone } from "./vercel-model"
import { createConfirm, formatWhen, VercelLinkRequired, type VercelNotice } from "./vercel-ui"

// Custom domains on the linked Vercel project, read from Vercel itself, with
// the exact DNS records Vercel asks for and the served certificate. The
// agent's add_domain, verify_domain and remove_domain call the same functions.
export function VercelDomains(props: { projectPath: string; notice: VercelNotice; onOpenConnections?: () => void }) {
  const api = vercelApi()
  const confirm = createConfirm()
  const [state, setState] = createStore({
    linked: true,
    project: "",
    domains: [] as VercelDomain[],
    draft: "",
    loading: false,
    busy: "",
  })

  const load = async () => {
    if (!api || !props.projectPath) return
    setState("loading", true)
    try {
      const status = await api.status(props.projectPath)
      setState("linked", Boolean(status.link))
      if (!status.link) {
        setState("domains", [])
        return
      }
      const listed = await api.domains(props.projectPath)
      setState({ project: listed.project, domains: listed.domains })
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not read the project's domains.") })
    } finally {
      setState("loading", false)
    }
  }

  createEffect(
    on(
      () => props.projectPath,
      () => void load(),
    ),
  )

  const replace = (domain: VercelDomain) =>
    setState("domains", (items) =>
      items.some((item) => item.name === domain.name)
        ? items.map((item) => (item.name === domain.name ? domain : item))
        : [domain, ...items],
    )

  const add = async () => {
    if (!api || !state.draft.trim()) return
    setState("busy", "add")
    try {
      const result = await api.domainAdd(props.projectPath, state.draft.trim())
      replace(result.domain)
      setState("draft", "")
      props.notice({
        tone: result.domain.status === "ready" ? "success" : "info",
        text: `${result.domain.name} is attached to ${result.project}. ${result.domain.detail}`,
      })
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Vercel did not accept that domain.") })
    } finally {
      setState("busy", "")
    }
  }

  const verify = async (domain: VercelDomain) => {
    if (!api) return
    setState("busy", `verify-${domain.name}`)
    try {
      const result = await api.domainVerify(props.projectPath, domain.name)
      replace(result.domain)
      props.notice({
        tone: result.domain.status === "ready" ? "success" : "info",
        text:
          result.domain.status === "ready"
            ? `${result.domain.name} is verified and points at Vercel.`
            : result.domain.detail,
      })
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not check that domain.") })
    } finally {
      setState("busy", "")
    }
  }

  const remove = async (domain: VercelDomain) => {
    if (!api) return
    setState("busy", `remove-${domain.name}`)
    try {
      const result = await api.domainRemove(props.projectPath, domain.name)
      setState("domains", (items) => items.filter((item) => item.name !== domain.name))
      props.notice({
        tone: "info",
        text: `Removed ${result.removed} from ${result.project}. Its DNS records can be deleted at your registrar.`,
      })
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not remove that domain.") })
    } finally {
      setState("busy", "")
    }
  }

  return (
    <VercelLinkRequired linked={state.linked} onOpenConnections={props.onOpenConnections}>
      <div class="cloud-panel vercel-section">
        <div class="vercel-section-head">
          <div>
            <div class="cloud-panel-title">Connect a domain{state.project ? ` to ${state.project}` : ""}</div>
            <p class="cloud-muted mt-1 text-[12px]">
              Add a domain you own. Vercel answers with the DNS records to set at your registrar; verify once they are
              in place.
            </p>
          </div>
          <button class="cloud-button" type="button" disabled={state.loading} onClick={() => void load()}>
            {state.loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <form
          class="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault()
            void add()
          }}
        >
          <input
            class="cloud-input min-w-0"
            value={state.draft}
            onInput={(event) => setState("draft", event.currentTarget.value)}
            placeholder="app.yourdomain.com"
            aria-label="Domain"
            autocomplete="off"
            spellcheck={false}
          />
          <button
            class="cloud-button"
            data-variant="primary"
            type="submit"
            disabled={!state.draft.trim() || Boolean(state.busy)}
          >
            {state.busy === "add" ? "Adding…" : "Add domain"}
          </button>
        </form>
      </div>
      <div class="cloud-list mt-3">
        <For
          each={state.domains}
          fallback={
            <p class="cloud-muted text-[12px]">
              {state.loading ? "Loading…" : "No custom domains on this project yet."}
            </p>
          }
        >
          {(domain) => (
            <div class="cloud-row cloud-row-block">
              <div class="min-w-0 flex-1">
                <div class="vercel-row-head">
                  <strong class="text-[13px] text-white/85">{domain.name}</strong>
                  <span class="cloud-status" data-tone={domainStatusTone(domain.status)}>
                    {domainStatusLabel(domain.status)}
                  </span>
                  <Show when={domain.certificate}>
                    {(certificate) => {
                      const current = certificate()
                      return (
                        <span class="cloud-status" data-tone={current.status === "issued" ? "success" : undefined}>
                          {current.status === "issued"
                            ? `Certificate until ${formatWhen(current.expiresAt)}`
                            : "Certificate pending"}
                        </span>
                      )
                    }}
                  </Show>
                  <Show when={domain.gitBranch}>
                    <span class="cloud-status">branch {domain.gitBranch}</span>
                  </Show>
                </div>
                <p class="cloud-muted text-[11.5px]">{domain.detail}</p>
                <Show when={domain.redirect}>
                  <p class="cloud-muted text-[11px]">Redirects to {domain.redirect}</p>
                </Show>
                <Show when={domain.records.length && domain.status !== "ready"}>
                  <div class="vercel-detail">
                    <p>Set these records at the domain's DNS provider:</p>
                    <div class="vercel-records">
                      <For each={domain.records}>
                        {(record) => (
                          <div class="vercel-record">
                            <span>{record.type}</span>
                            <code>{record.name}</code>
                            <code>{record.value}</code>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
              <div class="cloud-deployment-actions">
                <button
                  class="cloud-button"
                  type="button"
                  disabled={Boolean(state.busy)}
                  onClick={() => void verify(domain)}
                >
                  {state.busy === `verify-${domain.name}`
                    ? "Checking…"
                    : domain.status === "ready"
                      ? "Recheck"
                      : "Verify"}
                </button>
                <button
                  class="cloud-button"
                  data-variant="danger"
                  type="button"
                  disabled={Boolean(state.busy)}
                  onClick={() => confirm.request(`remove-${domain.name}`, () => void remove(domain))}
                >
                  {confirm.armed(`remove-${domain.name}`) ? "Confirm remove?" : "Remove"}
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </VercelLinkRequired>
  )
}
