import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js"
import type { DeployedFunction, FunctionSecret } from "./supabase-api"
import { createConfirm, failed, formatWhen, NotLinked, PanelHead, type SupabasePanelProps } from "./supabase-ui"
import "./supabase.css"

// Edge Functions: deploy a folder from supabase/functions, delete deployed
// ones, and manage the secrets they read. Secret values are write-only here.

export function SupabaseFunctions(props: SupabasePanelProps & { icon: JSX.Element }) {
  const confirm = createConfirm()
  const [deployed, setDeployed] = createSignal<DeployedFunction[]>()
  const [local, setLocal] = createSignal<string[]>([])
  const [secrets, setSecrets] = createSignal<FunctionSecret[]>([])
  const [busy, setBusy] = createSignal("")
  const [secretName, setSecretName] = createSignal("")
  const [secretValue, setSecretValue] = createSignal("")

  const deployedSlugs = createMemo(() => new Set((deployed() ?? []).map((item) => item.slug)))

  const load = async () => {
    const [functions, names] = await Promise.all([props.client.functions(), props.client.secrets()])
    if (!failed(props.notice, functions)) {
      setDeployed(functions.deployed ?? [])
      setLocal(functions.local ?? [])
    }
    if (!failed(props.notice, names)) setSecrets(names.secrets ?? [])
  }

  createEffect(
    on(
      () => props.linked,
      (linked) => {
        setDeployed(undefined)
        setLocal([])
        setSecrets([])
        if (linked) void load()
      },
    ),
  )

  const act = async (id: string, work: () => Promise<void>) => {
    if (busy()) return
    setBusy(id)
    try {
      await work()
    } finally {
      setBusy("")
    }
  }

  const deploy = (name: string) =>
    act(`deploy-${name}`, async () => {
      const report = await props.client.deployFunction(name)
      if (failed(props.notice, report)) return
      props.notice({ tone: "success", text: `${report.detail ?? "Deployed."} ${report.url ?? ""}`.trim() })
      await load()
    })

  const remove = (slug: string) =>
    act(`delete-${slug}`, async () => {
      const report = await props.client.deleteFunction(slug)
      if (failed(props.notice, report)) return
      props.notice({ tone: "info", text: report.detail ?? "Deleted." })
      await load()
    })

  const saveSecret = () =>
    act("secret", async () => {
      const report = await props.client.setSecret(secretName().trim(), secretValue())
      // The value has reached Supabase (or failed); either way it leaves the page.
      setSecretValue("")
      if (failed(props.notice, report)) return
      setSecretName("")
      props.notice({ tone: "success", text: report.detail ?? "Secret saved." })
      await load()
    })

  const removeSecret = (name: string) =>
    act(`secret-${name}`, async () => {
      const report = await props.client.deleteSecret(name)
      if (failed(props.notice, report)) return
      props.notice({ tone: "info", text: report.detail ?? "Secret deleted." })
      await load()
    })

  return (
    <Show
      when={props.linked}
      fallback={
        <NotLinked
          onOpenDatabase={props.onOpenDatabase}
          what="Edge Functions deploy to the Supabase project this repository uses."
          icon={props.icon}
        />
      }
    >
      <div class="sb-stack">
        <div class="cloud-panel">
          <PanelHead
            title="In this repository"
            detail="Folders in supabase/functions with an index file. Supabase bundles them on deploy; shared code in _shared is included."
          >
            <button class="cloud-button" type="button" disabled={Boolean(busy())} onClick={() => void load()}>
              Refresh
            </button>
          </PanelHead>
          <div class="cloud-list mt-3">
            <For
              each={local()}
              fallback={
                <p class="cloud-muted text-[12px]">
                  No functions in supabase/functions yet. Ask the agent to write one.
                </p>
              }
            >
              {(name) => (
                <div class="cloud-row">
                  <span class="min-w-0 flex-1 truncate text-[13px]">supabase/functions/{name}</span>
                  <Show when={deployedSlugs().has(name)}>
                    <span class="cloud-status" data-tone="success">
                      deployed
                    </span>
                  </Show>
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="button"
                    disabled={Boolean(busy())}
                    onClick={() => void deploy(name)}
                  >
                    {busy() === `deploy-${name}` ? "Deploying…" : deployedSlugs().has(name) ? "Redeploy" : "Deploy"}
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>

        <div class="cloud-panel">
          <PanelHead title="Deployed" />
          <div class="cloud-list mt-3">
            <For
              each={deployed() ?? []}
              fallback={<p class="cloud-muted text-[12px]">{deployed() ? "Nothing is deployed yet." : "Loading…"}</p>}
            >
              {(fn) => (
                <div class="cloud-row">
                  <span class="min-w-0 flex-1">
                    <strong class="block truncate text-[13px]">{fn.name}</strong>
                    <small class="cloud-muted">
                      {fn.slug}
                      {fn.version ? ` · version ${fn.version}` : ""} · updated {formatWhen(fn.updatedAt)}
                    </small>
                  </span>
                  <Show when={fn.status}>
                    <span class="cloud-status">{fn.status?.toLowerCase()}</span>
                  </Show>
                  <button
                    class="cloud-button"
                    data-variant="danger"
                    type="button"
                    disabled={Boolean(busy())}
                    onClick={() => confirm.ask(`delete-${fn.slug}`, () => void remove(fn.slug))}
                  >
                    {confirm.armed() === `delete-${fn.slug}` ? "Delete it live?" : "Delete"}
                  </button>
                </div>
              )}
            </For>
          </div>
        </div>

        <div class="cloud-panel">
          <PanelHead
            title="Secrets"
            detail="Values every function can read with Deno.env.get. They are sent to Supabase and only their names are shown."
          />
          <div class="sb-grid mt-3">
            <label class="sb-field">
              <span>Name</span>
              <input
                class="cloud-input"
                placeholder="RESEND_API_KEY"
                value={secretName()}
                onInput={(event) => setSecretName(event.currentTarget.value)}
              />
            </label>
            <label class="sb-field">
              <span>Value</span>
              <input
                class="cloud-input"
                type="password"
                autocomplete="off"
                value={secretValue()}
                onInput={(event) => setSecretValue(event.currentTarget.value)}
              />
            </label>
          </div>
          <div class="sb-actions mt-3">
            <button
              class="cloud-button"
              data-variant="primary"
              type="button"
              disabled={!secretName().trim() || !secretValue() || Boolean(busy())}
              onClick={() => void saveSecret()}
            >
              {busy() === "secret" ? "Saving…" : "Save secret"}
            </button>
          </div>
          <div class="cloud-list mt-3">
            <For each={secrets()}>
              {(secret) => (
                <div class="cloud-row">
                  <span class="min-w-0 flex-1">
                    <strong class="block truncate text-[13px]">{secret.name}</strong>
                    <small class="cloud-muted">
                      {secret.reserved ? "Provided by Supabase" : `updated ${formatWhen(secret.updatedAt)}`}
                    </small>
                  </span>
                  <Show when={!secret.reserved}>
                    <button
                      class="cloud-button"
                      data-variant="danger"
                      type="button"
                      disabled={Boolean(busy())}
                      onClick={() => confirm.ask(`secret-${secret.name}`, () => void removeSecret(secret.name))}
                    >
                      {confirm.armed() === `secret-${secret.name}` ? "Confirm delete?" : "Delete"}
                    </button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
