import { createEffect, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  vercelApi,
  vercelErrorText,
  VERCEL_ENV_TARGETS,
  type VercelEnvDiffRow,
  type VercelEnvPlan,
  type VercelEnvPullPlan,
  type VercelEnvTarget,
  type VercelRemoteEnv,
} from "./vercel-api"
import { envStateLabel, envStateTone, groupRemoteEnv } from "./vercel-model"
import { createConfirm, VercelLinkRequired, type VercelNotice } from "./vercel-ui"

type Draft = {
  key: string
  value: string
  targets: VercelEnvTarget[]
  gitBranch: string
  type: "encrypted" | "sensitive"
  editing: boolean
}

const emptyDraft = (): Draft => ({
  key: "",
  value: "",
  targets: ["preview", "development"],
  gitBranch: "",
  type: "encrypted",
  editing: false,
})

// The linked Vercel project's variables per environment. Remote values never
// reach this screen: it shows names, environments and types, compares by hash
// in the desktop, and writes only what the user reviewed.
export function VercelEnvironment(props: {
  projectPath: string
  notice: VercelNotice
  onLocalChange?: () => void
  onOpenConnections?: () => void
}) {
  const api = vercelApi()
  const confirm = createConfirm()
  const [state, setState] = createStore({
    linked: true,
    project: "",
    variables: [] as VercelRemoteEnv[],
    draft: emptyDraft(),
    diff: undefined as VercelEnvDiffRow[] | undefined,
    syncTargets: ["preview", "development"] as VercelEnvTarget[],
    plan: undefined as VercelEnvPlan | undefined,
    pullPlan: undefined as VercelEnvPullPlan | undefined,
    busy: "",
  })

  const load = async () => {
    if (!api || !props.projectPath) return
    const status = await api.status(props.projectPath).catch(() => undefined)
    setState("linked", Boolean(status?.link))
    if (!status?.link) return
    try {
      const listed = await api.env(props.projectPath)
      setState({ project: listed.project, variables: listed.variables })
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Could not read Vercel's variables.") })
    }
  }

  createEffect(
    on(
      () => props.projectPath,
      () => {
        setState({ diff: undefined, plan: undefined, pullPlan: undefined, draft: emptyDraft() })
        void load()
      },
    ),
  )

  const run = async (name: string, action: () => Promise<void>) => {
    setState("busy", name)
    try {
      await action()
    } catch (caught) {
      props.notice({ tone: "error", text: vercelErrorText(caught, "Vercel did not accept that change.") })
    } finally {
      setState("busy", "")
    }
  }

  const toggle = (list: VercelEnvTarget[], target: VercelEnvTarget) =>
    list.includes(target) ? list.filter((item) => item !== target) : VERCEL_ENV_TARGETS.filter((item) => item === target || list.includes(item))

  const save = () =>
    run("save", async () => {
      if (!api) return
      const current = state.draft
      const result = await api.envSet(props.projectPath, {
        key: current.key.trim(),
        value: current.value,
        // Store arrays are proxies, which IPC cannot clone.
        targets: [...current.targets],
        gitBranch: current.gitBranch.trim() || undefined,
        type: current.type,
      })
      setState("draft", emptyDraft())
      props.notice({
        tone: "success",
        text: `${result.action === "created" ? "Added" : "Updated"} ${result.key} for ${result.targets.join(", ")}. Redeploy for it to take effect.`,
      })
      await load()
    })

  const remove = (entry: VercelRemoteEnv) =>
    run(`remove-${entry.id}`, async () => {
      if (!api) return
      await api.envRemove(props.projectPath, {
        key: entry.key,
        targets: [...entry.targets],
        gitBranch: entry.gitBranch,
      })
      props.notice({ tone: "info", text: `Removed ${entry.key} from ${entry.targets.join(", ")}.` })
      await load()
    })

  const compare = () =>
    run("diff", async () => {
      if (!api) return
      setState("diff", (await api.envDiff(props.projectPath)).rows)
    })

  const review = () =>
    run("plan", async () => {
      if (!api) return
      setState("plan", await api.envPlan(props.projectPath, [...state.syncTargets]))
    })

  const apply = () =>
    run("apply", async () => {
      const current = state.plan
      if (!api || !current) return
      const applied = await api.envApply(props.projectPath, [...current.targets], current.id)
      setState("plan", undefined)
      props.notice({ tone: "success", text: `Applied ${applied.applied} change(s) to ${applied.project}. ${applied.nextStep}` })
      await load()
    })

  const reviewPull = () =>
    run("pull-plan", async () => {
      if (!api) return
      setState("pullPlan", await api.envPullPlan(props.projectPath))
    })

  const pull = () =>
    run("pull", async () => {
      const current = state.pullPlan
      if (!api || !current) return
      const pulled = await api.envPull(props.projectPath, current.id)
      setState("pullPlan", undefined)
      props.notice({ tone: "success", text: `Wrote ${pulled.keys.length} development value(s) to ${pulled.written}.` })
      props.onLocalChange?.()
    })

  const branchAllowed = () => state.draft.targets.length === 1 && state.draft.targets[0] === "preview"

  return (
    <VercelLinkRequired linked={state.linked} onOpenConnections={props.onOpenConnections}>
      <div class="cloud-panel vercel-section mt-3">
        <div class="vercel-section-head">
          <div>
            <div class="cloud-panel-title">On Vercel{state.project ? ` · ${state.project}` : ""}</div>
            <p class="cloud-muted mt-1 text-[12px]">
              Each variable per environment. Values stay on Vercel and in Vector's vault; this list shows names only.
            </p>
          </div>
          <div class="vercel-actions">
            <button class="cloud-button" type="button" disabled={Boolean(state.busy)} onClick={() => void compare()}>
              {state.busy === "diff" ? "Comparing…" : "Compare with local"}
            </button>
            <button class="cloud-button" type="button" disabled={Boolean(state.busy)} onClick={() => void reviewPull()}>
              {state.busy === "pull-plan" ? "Reading…" : "Pull development values"}
            </button>
          </div>
        </div>

        <form
          class="vercel-env-form"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <input
            class="cloud-input font-mono"
            placeholder="NAME"
            aria-label="Variable name"
            autocomplete="off"
            spellcheck={false}
            value={state.draft.key}
            disabled={state.draft.editing}
            onInput={(event) => setState("draft", "key", event.currentTarget.value)}
          />
          <input
            class="cloud-input"
            type="password"
            placeholder={state.draft.editing ? "new value" : "value"}
            aria-label="Variable value"
            autocomplete="off"
            spellcheck={false}
            value={state.draft.value}
            onInput={(event) => setState("draft", "value", event.currentTarget.value)}
          />
          <div class="vercel-targets" role="group" aria-label="Environments">
            <For each={VERCEL_ENV_TARGETS}>
              {(target) => (
                <label class="cloud-check-toggle">
                  <input
                    type="checkbox"
                    checked={state.draft.targets.includes(target)}
                    disabled={state.draft.editing}
                    onChange={() => setState("draft", "targets", (current) => toggle(current, target))}
                  />
                  <span>{target}</span>
                </label>
              )}
            </For>
          </div>
          <input
            class="cloud-input font-mono"
            placeholder="branch (preview only)"
            aria-label="Git branch"
            value={state.draft.gitBranch}
            disabled={!branchAllowed() || state.draft.editing}
            onInput={(event) => setState("draft", "gitBranch", event.currentTarget.value)}
          />
          <select
            class="cloud-input"
            aria-label="Variable type"
            value={state.draft.type}
            onChange={(event) =>
              setState("draft", "type", event.currentTarget.value === "sensitive" ? "sensitive" : "encrypted")
            }
          >
            <option value="encrypted">Encrypted</option>
            <option value="sensitive">Sensitive (never readable)</option>
          </select>
          <div class="vercel-actions">
            <button
              class="cloud-button"
              data-variant="primary"
              type="submit"
              disabled={!state.draft.key.trim() || !state.draft.targets.length || Boolean(state.busy)}
            >
              {state.busy === "save" ? "Saving…" : state.draft.editing ? "Change value" : "Add to Vercel"}
            </button>
            <Show when={state.draft.editing}>
              <button class="cloud-button" type="button" onClick={() => setState("draft", emptyDraft())}>
                Cancel
              </button>
            </Show>
          </div>
        </form>

        <div class="cloud-list mt-3">
          <For each={groupRemoteEnv(state.variables)} fallback={<p class="cloud-muted text-[12px]">No variables on Vercel yet.</p>}>
            {(group) => (
              <div class="cloud-row cloud-row-block">
                <div class="min-w-0 flex-1">
                  <code class="vercel-key">{group.key}</code>
                  <For each={group.entries}>
                    {(entry) => (
                      <div class="vercel-env-entry">
                        <For each={entry.targets}>{(target) => <span class="cloud-status">{target}</span>}</For>
                        <Show when={entry.gitBranch}>
                          <span class="cloud-status">branch {entry.gitBranch}</span>
                        </Show>
                        <span class="cloud-muted text-[11px]">
                          {entry.type}
                          {entry.syncedByVector ? " · synced by Vector" : ""}
                        </span>
                        <span class="flex-1" />
                        <button
                          class="cloud-button"
                          type="button"
                          onClick={() =>
                            setState("draft", {
                              key: entry.key,
                              value: "",
                              targets: [...entry.targets],
                              gitBranch: entry.gitBranch ?? "",
                              type: entry.type === "sensitive" ? "sensitive" : "encrypted",
                              editing: true,
                            })
                          }
                        >
                          Change value
                        </button>
                        <button
                          class="cloud-button"
                          data-variant="danger"
                          type="button"
                          disabled={Boolean(state.busy)}
                          onClick={() => confirm.request(`remove-${entry.id}`, () => void remove(entry))}
                        >
                          {confirm.armed(`remove-${entry.id}`) ? "Confirm remove?" : "Remove"}
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>

        <Show when={state.diff}>
          {(rows) => (
            <div class="vercel-detail mt-3">
              <strong class="text-[12.5px]">Local variables against Vercel (compared by hash)</strong>
              <table class="vercel-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <For each={VERCEL_ENV_TARGETS}>{(target) => <th>{target}</th>}</For>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()}>
                    {(row) => (
                      <tr>
                        <td>
                          <code>{row.key}</code>
                          {row.local ? "" : " (not local)"}
                        </td>
                        <For each={VERCEL_ENV_TARGETS}>
                          {(target) => (
                            <td>
                              <span class="cloud-status" data-tone={envStateTone(row.targets[target])}>
                                {envStateLabel(row.targets[target])}
                              </span>
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          )}
        </Show>

        <div class="vercel-detail mt-3">
          <strong class="text-[12.5px]">Sync this project's variables to Vercel</strong>
          <p class="cloud-muted text-[11.5px]">
            Creates what is missing, updates and deletes only what a Vector sync wrote before, and leaves variables made
            elsewhere alone. Review the plan; nothing is written until you apply it.
          </p>
          <div class="vercel-targets mt-2" role="group" aria-label="Environments to sync">
            <For each={VERCEL_ENV_TARGETS}>
              {(target) => (
                <label class="cloud-check-toggle">
                  <input
                    type="checkbox"
                    checked={state.syncTargets.includes(target)}
                    onChange={() => {
                      setState({ syncTargets: toggle(state.syncTargets, target), plan: undefined })
                    }}
                  />
                  <span>{target}</span>
                </label>
              )}
            </For>
            <button
              class="cloud-button"
              type="button"
              disabled={!state.syncTargets.length || Boolean(state.busy)}
              onClick={() => void review()}
            >
              {state.busy === "plan" ? "Planning…" : "Review plan"}
            </button>
          </div>
          <Show when={state.plan}>
            {(current) => (
              <div class="vercel-plan">
                <For each={current().changes} fallback={<p>Nothing to change: Vercel already matches.</p>}>
                  {(change) => (
                    <p>
                      <span class="cloud-status" data-tone={change.action === "delete" ? "error" : change.action === "update" ? "warning" : "success"}>
                        {change.action}
                      </span>{" "}
                      <code>{change.key}</code> · {change.targets.join(", ")}
                    </p>
                  )}
                </For>
                <For each={current().skipped}>
                  {(item) => (
                    <p class="cloud-muted">
                      Left alone: <code>{item.key}</code> ({item.targets.join(", ")}) · {item.reason}
                    </p>
                  )}
                </For>
                <Show when={current().changes.length}>
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="button"
                    disabled={Boolean(state.busy)}
                    onClick={() => confirm.request("apply", () => void apply())}
                  >
                    {state.busy === "apply"
                      ? "Applying…"
                      : confirm.armed("apply")
                        ? `Confirm ${current().changes.length} change(s) on ${current().targets.join(", ")}?`
                        : "Apply plan"}
                  </button>
                </Show>
              </div>
            )}
          </Show>
        </div>

        <Show when={state.pullPlan}>
          {(current) => (
            <div class="vercel-detail mt-3">
              <strong class="text-[12.5px]">Development values from {current().project} for this project's .env</strong>
              <div class="vercel-plan">
                <For each={current().variables} fallback={<p>Vercel has no readable development values.</p>}>
                  {(item) => (
                    <p>
                      <span class="cloud-status" data-tone={item.action === "overwrite" ? "warning" : item.action === "add" ? "success" : undefined}>
                        {item.action === "add" ? "add" : item.action === "overwrite" ? "replace local" : "same"}
                      </span>{" "}
                      <code>{item.key}</code>
                    </p>
                  )}
                </For>
                <For each={current().skipped}>
                  {(item) => (
                    <p class="cloud-muted">
                      Skipped <code>{item.key}</code>: {item.reason}
                    </p>
                  )}
                </For>
                <Show when={current().variables.some((item) => item.action !== "unchanged")}>
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="button"
                    disabled={Boolean(state.busy)}
                    onClick={() => confirm.request("pull", () => void pull())}
                  >
                    {state.busy === "pull" ? "Writing…" : confirm.armed("pull") ? "Confirm write to .env?" : "Write to .env"}
                  </button>
                </Show>
              </div>
            </div>
          )}
        </Show>
      </div>
    </VercelLinkRequired>
  )
}
