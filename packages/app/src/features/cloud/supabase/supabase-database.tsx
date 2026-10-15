import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { MigrationReview, MigrationState, SqlResult, SupabaseProgress, SupabaseProjects } from "./supabase-api"
import { createConfirm, failed, PanelHead, type SupabasePanelProps } from "./supabase-ui"
import "./supabase.css"

// Database: which Supabase project this repository uses (link, create, pause,
// restore, unlink), its server credentials, its migrations and a SQL console.

export function SupabaseDatabase(
  props: SupabasePanelProps & {
    connected: boolean
    onOpenConnections: () => void
    onDatabaseChange: () => Promise<void>
  },
) {
  const confirm = createConfirm()
  const [migrationReview, setMigrationReview] = createStore<{ plan?: MigrationReview }>({})
  const [projects, setProjects] = createSignal<SupabaseProjects>()
  const [mode, setMode] = createSignal<"link" | "create">("link")
  const [selection, setSelection] = createSignal("")
  const [organization, setOrganization] = createSignal("")
  const [region, setRegion] = createSignal("us-east-1")
  const [busy, setBusy] = createSignal("")
  const [progress, setProgress] = createSignal<SupabaseProgress[]>([])
  const [migrations, setMigrations] = createSignal<MigrationState>()
  const [writeUrl, setWriteUrl] = createSignal(true)
  const [syncVercel, setSyncVercel] = createSignal(false)
  const [password, setPassword] = createSignal("")
  const [sql, setSql] = createSignal("select * from information_schema.tables where table_schema = 'public' limit 50;")
  const [result, setResult] = createSignal<SqlResult>()
  const [pendingWrite, setPendingWrite] = createSignal("")
  const [draft, setDraft] = createStore({ open: false, name: "", sql: "", downSql: "" })

  onCleanup(props.client.subscribe((event) => setProgress((items) => [...items, event].slice(-12))))

  const linkedProject = createMemo(() => projects()?.projects.find((item) => item.ref === projects()?.linked?.ref))
  const chosenOrganization = createMemo(() => projects()?.organizations.find((item) => item.id === organization()))
  const paused = () => ["INACTIVE", "PAUSING", "PAUSED"].includes(linkedProject()?.status ?? "")

  const loadProjects = async () => {
    if (!props.connected) return
    const report = await props.client.projects()
    if (failed(props.notice, report)) return
    setProjects({
      organizations: report.organizations ?? [],
      projects: report.projects ?? [],
      linked: report.linked ?? null,
      pending: report.pending ?? null,
      regions: report.regions ?? [],
    })
    if (!organization() && report.organizations?.length === 1) setOrganization(report.organizations[0].id)
  }

  const loadMigrations = async () => {
    setMigrationReview("plan", undefined)
    if (!props.linked) return
    const report = await props.client.migrationStatus()
    if (!report.ok) {
      setMigrations(undefined)
      if (!report.needsSetup) failed(props.notice, report)
      return
    }
    setMigrations({ migrations: report.migrations, rollback: report.rollback, warnings: report.warnings })
  }

  createEffect(
    on(
      () => [props.connected, props.linked] as const,
      () => {
        setResult(undefined)
        setPendingWrite("")
        void loadProjects()
        void loadMigrations()
      },
    ),
  )

  const act = async (id: string, work: () => Promise<boolean | void>) => {
    if (busy()) return
    setBusy(id)
    try {
      await work()
    } finally {
      setBusy("")
    }
  }

  const link = () =>
    act("link", async () => {
      const report = await props.client.link(selection())
      if (failed(props.notice, report)) return
      await props.onDatabaseChange()
      props.notice({
        tone: "success",
        text: `Linked. Vector wrote the project's public URL and key to .env${
          report.client?.created ? ` and created ${report.client.path}` : ""
        }.${report.nextStep ? ` ${report.nextStep}` : ""}`,
      })
    })

  const create = (organizationId?: string, regionId?: string) =>
    act("create", async () => {
      setProgress([])
      const report = await props.client.createProject(organizationId, regionId)
      if (report.needsChoice) {
        props.notice({ tone: "info", text: "Choose which Supabase organization the new project belongs to." })
        return
      }
      if (failed(props.notice, report)) {
        await loadProjects()
        return
      }
      await props.onDatabaseChange()
      props.notice({ tone: "success", text: "The new Supabase project is live and linked to this repository." })
    })

  const unlink = () =>
    act("unlink", async () => {
      const report = await props.client.unlink()
      if (failed(props.notice, report)) return
      await props.onDatabaseChange()
      props.notice({ tone: "info", text: report.detail ?? "Unlinked." })
    })

  const pauseOrRestore = () =>
    act("power", async () => {
      const report = paused() ? await props.client.restore() : await props.client.pause()
      if (failed(props.notice, report)) return
      props.notice({ tone: "success", text: report.detail ?? "Done." })
      await loadProjects()
    })

  const writeDatabaseUrl = () =>
    act("database-url", async () => {
      const report = await props.client.writeDatabaseUrl(password().trim() || undefined)
      if (failed(props.notice, report)) return
      setPassword("")
      await props.onDatabaseChange()
      props.notice({ tone: "success", text: report.detail ?? "DATABASE_URL written." })
    })

  const rotate = () =>
    act("rotate", async () => {
      const report = await props.client.rotatePassword({ writeDatabaseUrl: writeUrl(), syncVercel: syncVercel() })
      if (failed(props.notice, report)) return
      await props.onDatabaseChange()
      // The password changed even if a later step did not; the detail says which.
      props.notice({ tone: report.problems?.length ? "error" : "success", text: report.detail ?? "Password rotated." })
    })

  const reviewMigrations = () =>
    act("review-migrations", async () => {
      const report = await props.client.planMigrations()
      if (failed(props.notice, report)) return
      if (report.migrations?.failed) {
        props.notice({ tone: "error", text: report.migrations.failed.error })
        return
      }
      if (!report.approvalID || !report.statements?.length) {
        props.notice({ tone: "info", text: "There are no pending migrations." })
        return
      }
      setMigrationReview("plan", { approvalID: report.approvalID, statements: report.statements })
    })

  const apply = () =>
    act("apply", async () => {
      const plan = migrationReview.plan
      if (!plan) return
      setMigrationReview("plan", undefined)
      const report = await props.client.applyMigrations(plan.approvalID)
      if (failed(props.notice, report)) return
      const outcome = report.migrations
      props.notice(
        outcome?.failed
          ? { tone: "error", text: `${outcome.failed.name} failed: ${outcome.failed.error}` }
          : { tone: "success", text: `Applied ${outcome?.applied.length ?? 0} migration(s).` },
      )
      await loadMigrations()
    })

  const createMigration = () =>
    act("new-migration", async () => {
      const report = await props.client.createMigration({
        name: draft.name.trim(),
        sql: draft.sql,
        downSql: draft.downSql.trim() || undefined,
      })
      if (failed(props.notice, report)) return
      setDraft({ open: false, name: "", sql: "", downSql: "" })
      props.notice({
        tone: "success",
        text: `Wrote ${report.file}${report.downFile ? ` and ${report.downFile}` : ""}. Review pending SQL to apply it.`,
      })
      await loadMigrations()
    })

  const rollback = (name: string) =>
    act("rollback", async () => {
      const report = await props.client.rollback(name)
      if (failed(props.notice, report)) return
      props.notice({ tone: "success", text: `Rolled back ${report.rolledBack}. ${report.nextStep ?? ""}` })
      await loadMigrations()
    })

  const runQuery = (write = false) =>
    act("sql", async () => {
      const text = write ? pendingWrite() : sql()
      const report = await props.client.runSql(text, write)
      if (report.needsConfirmation) {
        setPendingWrite(text)
        return
      }
      setPendingWrite("")
      if (failed(props.notice, report)) return
      setResult(report.result)
    })

  return (
    <div class="sb-stack">
      <Show
        when={props.connected}
        fallback={
          <div class="cloud-panel">
            <PanelHead
              title="Connect Supabase"
              detail="Connect your Supabase account to create a project or link one you already have."
            >
              <button class="cloud-button" data-variant="primary" type="button" onClick={props.onOpenConnections}>
                Set up Supabase connection
              </button>
            </PanelHead>
          </div>
        }
      >
        <Show
          when={props.linked}
          fallback={
            <div class="cloud-panel">
              <PanelHead
                title="Choose a database"
                detail="Link an existing Supabase project or create a new one on your account."
              >
                <div class="cloud-segment">
                  <button type="button" data-active={mode() === "link"} onClick={() => setMode("link")}>
                    Link existing
                  </button>
                  <button type="button" data-active={mode() === "create"} onClick={() => setMode("create")}>
                    Create new
                  </button>
                </div>
              </PanelHead>
              <Show when={projects()?.pending}>
                {(pending) => (
                  <div class="sb-confirm mt-3">
                    <span>
                      Vector started creating {pending().projectName} ({pending().region}) and it is not linked yet.
                      Finish it instead of creating another project.
                    </span>
                    <button
                      class="cloud-button"
                      type="button"
                      disabled={Boolean(busy())}
                      onClick={() => void create(pending().organizationId, pending().region)}
                    >
                      {busy() === "create" ? "Finishing…" : "Finish setup"}
                    </button>
                  </div>
                )}
              </Show>
              <Show when={mode() === "link"}>
                <div class="cloud-provider-linker mt-3">
                  <select
                    class="cloud-input"
                    value={selection()}
                    onChange={(event) => setSelection(event.currentTarget.value)}
                  >
                    <option value="">Choose a Supabase project</option>
                    <For each={projects()?.projects ?? []}>
                      {(project) => (
                        <option value={project.ref}>
                          {project.name}
                          {project.region ? ` · ${project.region}` : ""}
                          {project.status && project.status !== "ACTIVE_HEALTHY"
                            ? ` · ${project.status.toLowerCase()}`
                            : ""}
                        </option>
                      )}
                    </For>
                  </select>
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="button"
                    disabled={!selection() || Boolean(busy())}
                    onClick={() => void link()}
                  >
                    {busy() === "link" ? "Linking…" : "Use this project"}
                  </button>
                </div>
              </Show>
              <Show when={mode() === "create"}>
                <div class="sb-grid mt-3">
                  <label class="sb-field">
                    <span>Organization (billed for the project)</span>
                    <select
                      class="cloud-input"
                      value={organization()}
                      onChange={(event) => setOrganization(event.currentTarget.value)}
                    >
                      <option value="">Choose an organization</option>
                      <For each={projects()?.organizations ?? []}>
                        {(item) => (
                          <option value={item.id}>
                            {item.name}
                            {item.plan ? ` · ${item.plan} plan` : ""}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <label class="sb-field">
                    <span>Region</span>
                    <select
                      class="cloud-input"
                      value={region()}
                      onChange={(event) => setRegion(event.currentTarget.value)}
                    >
                      <For each={projects()?.regions ?? []}>
                        {(item) => (
                          <option value={item.id}>
                            {item.label} ({item.id})
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                </div>
                <div class="sb-actions mt-3">
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="button"
                    disabled={!organization() || Boolean(busy())}
                    onClick={() => confirm.ask("create", () => void create(organization(), region()))}
                  >
                    {busy() === "create"
                      ? "Creating…"
                      : confirm.armed() === "create"
                        ? `Create in ${chosenOrganization()?.name ?? "this organization"}?`
                        : "Create Supabase project"}
                  </button>
                  <span class="cloud-muted text-[12px]">
                    Supabase bills {chosenOrganization()?.name ?? "the chosen organization"}
                    {chosenOrganization()?.plan ? ` (${chosenOrganization()?.plan} plan)` : ""} for the new project.
                  </span>
                </div>
              </Show>
              <Show when={progress().length && busy() === "create"}>
                <ul class="sb-progress">
                  <For each={progress()}>{(event) => <li>{event.message}</li>}</For>
                </ul>
              </Show>
            </div>
          }
        >
          <div class="cloud-panel cloud-gradient-edge">
            <PanelHead
              title={props.projectName ?? projects()?.linked?.name ?? "Supabase project"}
              detail={`${projects()?.linked?.ref ?? ""}${linkedProject()?.region ? ` · ${linkedProject()?.region}` : ""}${
                linkedProject()?.status ? ` · ${linkedProject()?.status?.toLowerCase().replaceAll("_", " ")}` : ""
              }`}
            >
              <button
                class="cloud-button"
                type="button"
                disabled={Boolean(busy()) || !linkedProject()}
                onClick={() => confirm.ask("power", () => void pauseOrRestore())}
              >
                {busy() === "power"
                  ? "Working…"
                  : confirm.armed() === "power"
                    ? paused()
                      ? "Restore? It is billed again"
                      : "Pause? The live app goes down"
                    : paused()
                      ? "Restore"
                      : "Pause"}
              </button>
              <button
                class="cloud-button"
                data-variant="danger"
                type="button"
                disabled={Boolean(busy())}
                onClick={() => confirm.ask("unlink", () => void unlink())}
              >
                {confirm.armed() === "unlink" ? "Confirm unlink?" : "Unlink"}
              </button>
            </PanelHead>
          </div>

          <div class="cloud-panel">
            <PanelHead
              title="Server credentials"
              detail="DATABASE_URL lets server code, ORMs and migration tools reach the database through the transaction pooler. It holds the database password, so it is server-only and never shown."
            >
              <button
                class="cloud-button"
                type="button"
                disabled={Boolean(busy())}
                onClick={() => confirm.ask("database-url", () => void writeDatabaseUrl())}
              >
                {confirm.armed() === "database-url" ? "Write the password into .env?" : "Write DATABASE_URL"}
              </button>
            </PanelHead>
            <label class="sb-field mt-3">
              <span>
                Current database password, for a project Vector did not create. Vector keeps it encrypted and never
                shows it; leave it empty if Vector created or rotated the password.
              </span>
              <input
                class="cloud-input"
                type="password"
                autocomplete="off"
                value={password()}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
            </label>
            <div class="sb-actions mt-3">
              <label class="sb-check">
                <input
                  type="checkbox"
                  checked={writeUrl()}
                  onChange={(event) => setWriteUrl(event.currentTarget.checked)}
                />
                Write DATABASE_URL with the new password
              </label>
              <label class="sb-check">
                <input
                  type="checkbox"
                  checked={syncVercel()}
                  onChange={(event) => setSyncVercel(event.currentTarget.checked)}
                />
                Push the environment to Vercel
              </label>
              <button
                class="cloud-button"
                data-variant="danger"
                type="button"
                disabled={Boolean(busy())}
                onClick={() => confirm.ask("rotate", () => void rotate())}
              >
                {busy() === "rotate"
                  ? "Rotating…"
                  : confirm.armed() === "rotate"
                    ? "Reset it? The old password stops working"
                    : "Rotate database password"}
              </button>
            </div>
          </div>

          <div class="cloud-panel">
            <PanelHead
              title="Migrations"
              detail={
                migrations()?.migrations
                  ? `${migrations()?.migrations?.directory} · ${migrations()?.migrations?.alreadyApplied.length} applied · ${migrations()?.migrations?.pending.length} pending`
                  : "Write a migration here, or as a .sql file in supabase/migrations, then apply it here."
              }
            >
              <button
                class="cloud-button"
                type="button"
                disabled={Boolean(busy())}
                onClick={() => void loadMigrations()}
              >
                Refresh
              </button>
              <button
                class="cloud-button"
                type="button"
                disabled={Boolean(busy())}
                onClick={() => setDraft("open", !draft.open)}
              >
                {draft.open ? "Close" : "New migration"}
              </button>
              <Show when={migrations()?.migrations?.pending.length}>
                <button
                  class="cloud-button"
                  data-variant="primary"
                  type="button"
                  disabled={Boolean(busy()) || Boolean(migrations()?.migrations?.changed.length)}
                  onClick={() => void reviewMigrations()}
                >
                  {busy() === "review-migrations" ? "Reading SQL…" : "Review pending SQL"}
                </button>
              </Show>
              <Show when={migrations()?.rollback?.available ? migrations()?.rollback : undefined}>
                {(candidate) => (
                  <button
                    class="cloud-button"
                    data-variant="danger"
                    type="button"
                    disabled={Boolean(busy())}
                    onClick={() => confirm.ask("rollback", () => void rollback(candidate().name))}
                  >
                    {confirm.armed() === "rollback" ? `Undo ${candidate().name}?` : "Roll back latest"}
                  </button>
                )}
              </Show>
            </PanelHead>
            <Show when={draft.open}>
              <form
                class="sb-section"
                onSubmit={(event) => {
                  event.preventDefault()
                  void createMigration()
                }}
              >
                <label class="cloud-token-field">
                  <span>Name</span>
                  <input
                    class="cloud-input"
                    placeholder="add_profiles"
                    spellcheck={false}
                    value={draft.name}
                    onInput={(event) => setDraft("name", event.currentTarget.value)}
                  />
                </label>
                <label class="cloud-token-field mt-3">
                  <span>SQL</span>
                  <textarea
                    class="sb-textarea"
                    spellcheck={false}
                    value={draft.sql}
                    onInput={(event) => setDraft("sql", event.currentTarget.value)}
                  />
                </label>
                <label class="cloud-token-field mt-3">
                  <span>Down SQL (undoes it; without it Vector cannot roll it back)</span>
                  <textarea
                    class="sb-textarea"
                    spellcheck={false}
                    value={draft.downSql}
                    onInput={(event) => setDraft("downSql", event.currentTarget.value)}
                  />
                </label>
                <div class="sb-actions mt-3">
                  <button
                    class="cloud-button"
                    data-variant="primary"
                    type="submit"
                    disabled={Boolean(busy()) || !draft.name.trim() || !draft.sql.trim()}
                  >
                    {busy() === "new-migration" ? "Writing…" : "Write migration file"}
                  </button>
                  <span class="cloud-muted text-[12px]">
                    Vector writes the file into this repository; nothing reaches the database until you apply it.
                  </span>
                </div>
              </form>
            </Show>
            <Show when={migrationReview.plan}>
              {(plan) => (
                <div class="sb-section">
                  <p>Review this SQL before applying it to {props.projectName ?? "production"}.</p>
                  <For each={plan().statements}>
                    {(statement) => (
                      <div class="mt-3">
                        <strong>{statement.label}</strong>
                        <pre class="whitespace-pre-wrap break-all text-[12px]">{statement.sql}</pre>
                      </div>
                    )}
                  </For>
                  <div class="sb-actions mt-3">
                    <button
                      class="cloud-button"
                      data-variant="danger"
                      type="button"
                      disabled={Boolean(busy())}
                      onClick={() => void apply()}
                    >
                      Apply reviewed SQL
                    </button>
                    <button class="cloud-button" type="button" onClick={() => setMigrationReview("plan", undefined)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Show>
            <For each={migrations()?.warnings ?? []}>
              {(warning) => <p class="cloud-muted mt-3 text-[12px]">{warning}</p>}
            </For>
            <Show when={migrations()?.migrations}>
              {(state) => (
                <div class="cloud-list mt-3">
                  <For each={state().discovered}>
                    {(name) => {
                      const status = () =>
                        state().changed.includes(name)
                          ? { tone: "error", label: "changed after apply" }
                          : state().appliedByCli.includes(name)
                            ? { tone: "success", label: "applied by CLI" }
                            : state().alreadyApplied.includes(name)
                              ? { tone: "success", label: "applied" }
                              : { tone: "warning", label: "pending" }
                      return (
                        <div class="cloud-row">
                          <span class="min-w-0 flex-1 truncate text-[12.5px]">{name}</span>
                          <Show when={migrations()?.rollback?.name === name && !migrations()?.rollback?.available}>
                            <span class="cloud-muted text-[11px]">no down migration</span>
                          </Show>
                          <span class="cloud-status" data-tone={status().tone}>
                            {status().label}
                          </span>
                        </div>
                      )
                    }}
                  </For>
                </div>
              )}
            </Show>
          </div>

          <div class="cloud-panel">
            <PanelHead
              title="SQL console"
              detail="Queries run read-only. A query that changes data stops and asks before it runs against the live database."
            >
              <button
                class="cloud-button"
                data-variant="primary"
                type="button"
                disabled={!sql().trim() || Boolean(busy())}
                onClick={() => void runQuery()}
              >
                {busy() === "sql" ? "Running…" : "Run"}
              </button>
            </PanelHead>
            <textarea
              class="sb-textarea mt-3"
              spellcheck={false}
              value={sql()}
              onInput={(event) => setSql(event.currentTarget.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void runQuery()
              }}
            />
            <Show when={pendingWrite()}>
              <div class="sb-confirm mt-3">
                <span>
                  This query changes data in {props.projectName ?? "the linked project"} (production). Run it?
                </span>
                <span class="sb-actions">
                  <button class="cloud-button" type="button" onClick={() => setPendingWrite("")}>
                    Cancel
                  </button>
                  <button class="cloud-button" data-variant="danger" type="button" onClick={() => void runQuery(true)}>
                    Run as a write
                  </button>
                </span>
              </div>
            </Show>
            <Show when={result()}>
              {(table) => (
                <>
                  <p class="cloud-muted mt-3 text-[12px]">
                    {table().rowCount} row{table().rowCount === 1 ? "" : "s"}
                    {table().truncated ? `, first ${table().rows.length} shown` : ""} ·{" "}
                    {table().readOnly ? "read-only" : "write"}
                  </p>
                  <Show when={table().columns.length}>
                    <div class="sb-table-wrap mt-2">
                      <table class="sb-table">
                        <thead>
                          <tr>
                            <For each={table().columns}>{(column) => <th>{column}</th>}</For>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={table().rows}>
                            {(row) => (
                              <tr>
                                <For each={row}>
                                  {(cell) => (
                                    <td title={cell === null ? "null" : String(cell)}>
                                      {cell === null ? <span class="sb-null">null</span> : String(cell)}
                                    </td>
                                  )}
                                </For>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  )
}
