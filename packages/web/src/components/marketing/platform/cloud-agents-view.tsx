/** @jsxImportSource react */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import type { Session } from "@supabase/supabase-js"
import {
  AlertTriangle,
  Bot,
  Boxes,
  CircleStop,
  Cloud,
  Download,
  FileCode2,
  GitBranch,
  Link2,
  ListTree,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  TerminalSquare,
  Trash2,
  Users,
  X,
} from "lucide-react"
import { apiFetch, formatDate, formatDuration, type PlatformConfig } from "./platform-client"

type Run = {
  id: string
  team_id?: string | null
  name: string
  prompt: string
  repository_url?: string | null
  repository_branch?: string | null
  model: string
  status: string
  current_step?: string | null
  selected_tools: string[]
  summary?: string | null
  logs?: string | null
  diff?: string | null
  diff_stats?: {
    changedFiles?: number
    additions?: number
    deletions?: number
    files?: Array<{ path: string; added: number; deleted: number }>
  } | null
  token_usage?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number } | null
  cost_usd?: number | null
  error?: string | null
  started_at?: string | null
  completed_at?: string | null
  created_at: string
  updated_at: string
}

type Message = { id: string; role: string; content: string; created_at: string }
type Team = { id: string; name: string; objective: string; status: string; created_at: string; updated_at: string }
type Connection = {
  id: string
  plugin_id?: string | null
  name: string
  kind: "plugin" | "mcp_remote" | "mcp_local"
  enabled: boolean
  last_status: string
}
type Tool = {
  id: string
  name: string
  category: string
  description: string
  auth: "none" | "token" | "oauth"
  cloudSupport: "ready" | "oauth_required" | "secret_broker_required" | "runtime_required" | "desktop_only"
  cloudNote: string
  fields?: Array<{ key: string; label: string; secret?: boolean }>
}
type TeamCreation = {
  team: Team
  runs: Run[]
  failures?: Array<{ id: string; message: string }>
}
type Notice = { tone: "error" | "success"; message: string }

const activeStatuses = ["queued", "starting", "running", "needs_input"]

function displayStatus(value: string) {
  return value.replaceAll("_", " ")
}

function mergeRecords<T extends { id: string }>(incoming: T[], current: T[]) {
  const incomingIds = new Set(incoming.map((item) => item.id))
  return [...incoming, ...current.filter((item) => !incomingIds.has(item.id))]
}

function isToolCloudReady(tool?: Tool) {
  return tool?.cloudSupport === "ready"
}

function isConnectionCloudReady(connection: Connection, catalog: Tool[]) {
  if (connection.kind !== "plugin") return true
  return isToolCloudReady(catalog.find((tool) => tool.id === connection.plugin_id))
}

function fallbackTeamStatus(runs: Run[]) {
  if (runs.some((run) => activeStatuses.includes(run.status))) return "active"
  if (runs.length > 0 && runs.every((run) => run.status === "complete")) return "complete"
  if (runs.some((run) => run.status === "failed")) return "review"
  return "idle"
}

function useModelChoice(models: string[]) {
  const [model, setModel] = useState(models[0] || "")

  useEffect(() => {
    setModel((current) => (current && models.includes(current) ? current : models[0] || ""))
  }, [models])

  return [model, setModel] as const
}

function AccessibleModal(props: {
  children: ReactNode
  className?: string
  titleId: string
  descriptionId?: string
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    const frame = window.requestAnimationFrame(() => {
      const preferred = dialog?.querySelector<HTMLElement>("[data-autofocus='true']")
      ;(preferred || dialog)?.focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeRef.current()
        return
      }
      if (event.key !== "Tab" || !dialog) return

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true")
      if (!focusable.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = previousOverflow
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus()
    }
  }, [])

  return (
    <div
      className="platform-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current()
      }}
    >
      <div
        ref={dialogRef}
        className={`platform-modal${props.className ? ` ${props.className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.titleId}
        aria-describedby={props.descriptionId}
        tabIndex={-1}
      >
        {props.children}
      </div>
    </div>
  )
}

export function CloudAgentsView(props: { session: Session; config?: PlatformConfig }) {
  const [runs, setRuns] = useState<Run[]>([])
  const [models, setModels] = useState<string[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [selectedId, setSelectedId] = useState("")
  const selectedIdRef = useRef("")
  const [selectedRun, setSelectedRun] = useState<Run>()
  const [messages, setMessages] = useState<Message[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [catalog, setCatalog] = useState<Tool[]>([])
  const [createAgentOpen, setCreateAgentOpen] = useState(false)
  const [createTeamOpen, setCreateTeamOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Run>()
  const [reviewTab, setReviewTab] = useState<"activity" | "changes" | "terminal">("activity")
  const [busy, setBusy] = useState("")
  const [notice, setNotice] = useState<Notice>()

  const reportError = (message: string) => setNotice({ tone: "error", message })

  const loadRuns = async () => {
    try {
      const payload = await apiFetch("/api/agents/runs", props.session)
      const nextRuns = (payload.runs || []) as Run[]
      setRuns(nextRuns)
      setModels(payload.models || [])
      setTeams(payload.teams || [])
      setSelectedId((current) =>
        current && nextRuns.some((run) => run.id === current) ? current : nextRuns[0]?.id || "",
      )
    } catch (cause) {
      reportError(cause instanceof Error ? cause.message : "Vector could not load Cloud Agents.")
    }
  }

  const loadConnections = async () => {
    try {
      const [saved, available] = await Promise.all([
        apiFetch("/api/platform/connections", props.session),
        apiFetch("/api/platform/catalog", props.session),
      ])
      setConnections(saved.connections || [])
      setCatalog(available.tools || [])
    } catch (cause) {
      reportError(cause instanceof Error ? cause.message : "Vector could not load integrations.")
    }
  }

  const loadSelected = async () => {
    if (!selectedId) return
    try {
      const payload = await apiFetch(`/api/agents/run?id=${encodeURIComponent(selectedId)}`, props.session)
      if (!payload.run || payload.run.id !== selectedIdRef.current) return
      setSelectedRun(payload.run)
      setMessages(payload.messages || [])
      setRuns((current) => current.map((run) => (run.id === payload.run.id ? payload.run : run)))
    } catch (cause) {
      if (selectedId === selectedIdRef.current) {
        reportError(cause instanceof Error ? cause.message : "Vector could not refresh this agent.")
      }
    }
  }

  useEffect(() => {
    void Promise.all([loadRuns(), loadConnections()])
  }, [props.session.access_token])
  useEffect(() => {
    selectedIdRef.current = selectedId
    if (!selectedId) {
      setSelectedRun(undefined)
      setMessages([])
      return
    }
    const cached = runs.find((run) => run.id === selectedId)
    if (cached) setSelectedRun(cached)
    setMessages([])
    void loadSelected()
  }, [selectedId])
  useEffect(() => {
    if (!selectedRun || !activeStatuses.includes(selectedRun.status)) return
    const timer = window.setInterval(() => {
      void loadSelected()
      void loadRuns()
    }, 2600)
    return () => window.clearInterval(timer)
  }, [selectedRun?.id, selectedRun?.status])

  const teamGroups = useMemo(() => {
    const buckets = new Map<string, Run[]>()
    for (const run of runs) {
      if (!run.team_id) continue
      buckets.set(run.team_id, [...(buckets.get(run.team_id) || []), run])
    }
    const ordered: Array<{ team: Team | undefined; runs: Run[] }> = teams
      .map((team) => ({ team, runs: buckets.get(team.id) || [] }))
      .filter((group) => group.runs.length > 0)
    const knownIds = new Set(teams.map((team) => team.id))
    for (const [teamId, teamRuns] of buckets) {
      if (!knownIds.has(teamId)) ordered.push({ team: undefined, runs: teamRuns })
    }
    return ordered
  }, [runs, teams])

  const independentGroups = useMemo(() => {
    const independent = runs.filter((run) => !run.team_id)
    return [
      ["Running", independent.filter((run) => activeStatuses.includes(run.status))],
      ["Ready for review", independent.filter((run) => run.status === "complete")],
      ["History", independent.filter((run) => ["failed", "canceled"].includes(run.status))],
    ] as const
  }, [runs])

  const selectedTeam = selectedRun?.team_id ? teams.find((team) => team.id === selectedRun.team_id) : undefined

  const stopRun = async () => {
    if (!selectedRun) return
    setBusy("stop")
    setNotice(undefined)
    try {
      await apiFetch("/api/agents/run", props.session, {
        method: "POST",
        body: JSON.stringify({ id: selectedRun.id, action: "stop" }),
      })
      await Promise.all([loadSelected(), loadRuns()])
    } catch (cause) {
      reportError(cause instanceof Error ? cause.message : "Vector could not stop the cloud agent.")
    } finally {
      setBusy("")
    }
  }

  const deleteRun = async (run: Run) => {
    await apiFetch("/api/agents/run", props.session, {
      method: "DELETE",
      body: JSON.stringify({ id: run.id }),
    })
    const remaining = runs.filter((item) => item.id !== run.id)
    setRuns(remaining)
    if (selectedId === run.id) {
      const next = remaining[0]
      selectedIdRef.current = next?.id || ""
      setSelectedId(next?.id || "")
      setSelectedRun(next)
      setMessages([])
    }
    setNotice({ tone: "success", message: `${run.name} was deleted.` })
    void loadRuns()
  }

  const downloadPatch = () => {
    if (!selectedRun?.diff) return
    const url = URL.createObjectURL(new Blob([selectedRun.diff], { type: "text/x-diff" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `${selectedRun.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "vector-agent"}.patch`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleAgentCreated = (run: Run) => {
    setCreateAgentOpen(false)
    setRuns((current) => mergeRecords([run], current))
    setSelectedRun(run)
    setSelectedId(run.id)
    setMessages([])
    setNotice({ tone: "success", message: `${run.name} is launching.` })
    void loadRuns()
  }

  const handleTeamCreated = (payload: TeamCreation) => {
    setCreateTeamOpen(false)
    setTeams((current) => mergeRecords([payload.team], current))
    setRuns((current) => mergeRecords(payload.runs, current))
    const firstRun = payload.runs[0]
    if (firstRun) {
      setSelectedRun(firstRun)
      setSelectedId(firstRun.id)
      setMessages([])
    }
    if (payload.failures?.length) {
      setNotice({
        tone: "error",
        message: `${payload.team.name} was created, but ${payload.failures.length} ${payload.failures.length === 1 ? "agent" : "agents"} could not start.`,
      })
    } else {
      setNotice({ tone: "success", message: `${payload.team.name} launched with ${payload.runs.length} agents.` })
    }
    void loadRuns()
  }

  return (
    <div className="platform-page agents-page">
      <header className="platform-page-header">
        <div className="platform-page-title">
          <span>
            <Cloud size={17} />
          </span>
          <div>
            <h1>Cloud Agents</h1>
            <p>Persistent agents in isolated workspaces, alone or as a coordinated team.</p>
          </div>
        </div>
        <div className="agents-header-actions">
          <span className="platform-status" data-state={props.config?.services.cloudAgents ? "active" : "failed"}>
            {props.config?.services.cloudAgents ? "runtime ready" : "setup required"}
          </span>
          <button className="platform-secondary" onClick={() => setToolsOpen(true)}>
            <Settings2 size={14} />
            Integrations
          </button>
          <button className="platform-secondary" onClick={() => setCreateTeamOpen(true)}>
            <Users size={14} />
            New team
          </button>
          <button className="platform-primary" onClick={() => setCreateAgentOpen(true)}>
            <Plus size={14} />
            New agent
          </button>
        </div>
      </header>

      <div className="agents-workbench">
        <aside className="agents-list" aria-label="Cloud workspaces">
          <div className="agents-list-head">
            <strong>Workspaces</strong>
            <button
              type="button"
              title="Refresh workspaces"
              aria-label="Refresh workspaces"
              onClick={() => {
                void loadRuns()
                void loadSelected()
              }}
            >
              <RefreshCw size={13} />
            </button>
          </div>

          {teamGroups.map(({ team, runs: teamRuns }) => {
            const status = team?.status || fallbackTeamStatus(teamRuns)
            return (
              <section className="agents-team-group" key={team?.id || teamRuns[0]?.team_id}>
                <div className="agents-team-heading">
                  <span>
                    <Users size={12} />
                    <strong>{team?.name || "Agent team"}</strong>
                    <small>{teamRuns.length}</small>
                  </span>
                  <span className="platform-status" data-state={status}>
                    {displayStatus(status)}
                  </span>
                </div>
                {team?.objective && (
                  <p className="agents-team-objective" title={team.objective}>
                    {team.objective}
                  </p>
                )}
                {teamRuns.map((run) => (
                  <RunListButton key={run.id} run={run} active={run.id === selectedId} onSelect={setSelectedId} />
                ))}
              </section>
            )
          })}

          {independentGroups.map(
            ([label, items]) =>
              items.length > 0 && (
                <section className="agents-independent-group" key={label}>
                  <div className="agents-group-heading">
                    <span>{label}</span>
                    <b>{items.length}</b>
                  </div>
                  {items.map((run) => (
                    <RunListButton key={run.id} run={run} active={run.id === selectedId} onSelect={setSelectedId} />
                  ))}
                </section>
              ),
          )}

          {!runs.length && (
            <div className="agents-list-empty">
              <Bot size={20} />
              <span>No cloud agents yet.</span>
            </div>
          )}
        </aside>

        <section className="agent-session">
          {!selectedRun ? (
            <div className="platform-empty">
              <Users size={30} />
              <h2>Launch an engineer, not a chat box.</h2>
              <p>Give one agent a focused mission, or divide a shared objective across a coordinated team.</p>
              <div className="platform-empty-actions">
                <button className="platform-primary" onClick={() => setCreateAgentOpen(true)}>
                  <Plus size={14} />
                  New agent
                </button>
                <button className="platform-secondary" onClick={() => setCreateTeamOpen(true)}>
                  <Users size={14} />
                  New team
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="agent-session-head">
                <div>
                  <div>
                    <GitBranch size={14} />
                    <strong>{selectedRun.name}</strong>
                    <span className="platform-status" data-state={selectedRun.status}>
                      {displayStatus(selectedRun.status)}
                    </span>
                  </div>
                  <p>
                    {selectedRun.repository_url || "Blank isolated workspace"}
                    {selectedRun.repository_branch ? ` · ${selectedRun.repository_branch}` : ""}
                  </p>
                </div>
                <div>
                  <button
                    className="platform-icon-button"
                    title="Download patch"
                    aria-label="Download patch"
                    onClick={downloadPatch}
                    disabled={!selectedRun.diff}
                  >
                    <Download size={14} />
                  </button>
                  {activeStatuses.includes(selectedRun.status) && (
                    <button className="platform-danger" onClick={() => void stopRun()} disabled={!!busy}>
                      <CircleStop size={14} />
                      {busy === "stop" ? "Stopping..." : "Stop"}
                    </button>
                  )}
                  <button
                    className="platform-icon-button"
                    title="Delete workspace"
                    aria-label={`Delete ${selectedRun.name}`}
                    onClick={() => setDeleteTarget(selectedRun)}
                    disabled={!!busy}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="agent-conversation">
                <div className="agent-task-brief">
                  <span>Mission</span>
                  <p>{selectedRun.prompt}</p>
                  <div>
                    <span>
                      <Bot size={12} />
                      {selectedRun.model}
                    </span>
                    <span>
                      <Boxes size={12} />
                      {selectedTeam ? `${selectedTeam.name} · ${displayStatus(selectedTeam.status)}` : "Independent"}
                    </span>
                    <span>{formatDuration(selectedRun.started_at, selectedRun.completed_at)}</span>
                  </div>
                </div>
                {messages.map((message) => (
                  <article key={message.id} data-role={message.role}>
                    <header>
                      <span>{message.role === "user" ? "You" : "Vector Cloud Agent"}</span>
                      <time>{formatDate(message.created_at)}</time>
                    </header>
                    <p>{message.content}</p>
                  </article>
                ))}
                {selectedRun.error && (
                  <div className="agent-error" role="alert">
                    <strong>Run failed</strong>
                    <p>{selectedRun.error}</p>
                  </div>
                )}
                {activeStatuses.includes(selectedRun.status) && (
                  <div className="agent-live">
                    <i />
                    <span>{selectedRun.current_step || "Agent is working"}</span>
                  </div>
                )}
              </div>
              <AgentComposer run={selectedRun} session={props.session} onSent={loadSelected} setError={reportError} />
            </>
          )}
        </section>

        <aside className="agent-inspector">
          <div className="platform-tabs" role="tablist" aria-label="Run details">
            <button
              role="tab"
              aria-selected={reviewTab === "activity"}
              data-active={reviewTab === "activity"}
              onClick={() => setReviewTab("activity")}
            >
              <ListTree size={12} />
              Activity
            </button>
            <button
              role="tab"
              aria-selected={reviewTab === "changes"}
              data-active={reviewTab === "changes"}
              onClick={() => setReviewTab("changes")}
            >
              <FileCode2 size={12} />
              Changes
            </button>
            <button
              role="tab"
              aria-selected={reviewTab === "terminal"}
              data-active={reviewTab === "terminal"}
              onClick={() => setReviewTab("terminal")}
            >
              <TerminalSquare size={12} />
              Log
            </button>
          </div>
          {!selectedRun ? (
            <div className="agent-inspector-empty">Select an agent to inspect its work.</div>
          ) : reviewTab === "activity" ? (
            <AgentActivity run={selectedRun} connections={connections} />
          ) : reviewTab === "changes" ? (
            <AgentChanges run={selectedRun} />
          ) : (
            <pre className="agent-log">{selectedRun.logs || "Execution output will appear here."}</pre>
          )}
        </aside>
      </div>

      {notice && (
        <div className="agents-toast" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.message}</span>
          <button aria-label="Dismiss notification" onClick={() => setNotice(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}

      {createAgentOpen && (
        <CreateAgentModal
          session={props.session}
          models={models}
          teams={teams}
          connections={connections}
          catalog={catalog}
          onClose={() => setCreateAgentOpen(false)}
          onCreated={handleAgentCreated}
        />
      )}
      {createTeamOpen && (
        <CreateTeamModal
          session={props.session}
          models={models}
          connections={connections}
          catalog={catalog}
          onClose={() => setCreateTeamOpen(false)}
          onCreated={handleTeamCreated}
        />
      )}
      {toolsOpen && (
        <ToolsModal
          session={props.session}
          connections={connections}
          catalog={catalog}
          onClose={() => setToolsOpen(false)}
          onChanged={loadConnections}
        />
      )}
      {deleteTarget && (
        <DeleteRunModal
          key={deleteTarget.id}
          run={deleteTarget}
          onClose={() => setDeleteTarget(undefined)}
          onConfirm={() => deleteRun(deleteTarget)}
        />
      )}
    </div>
  )
}

function RunListButton(props: { run: Run; active: boolean; onSelect: (id: string) => void }) {
  return (
    <button className="agent-run-row" data-active={props.active} onClick={() => props.onSelect(props.run.id)}>
      <i data-status={props.run.status} />
      <div>
        <strong>{props.run.name}</strong>
        <small>{props.run.current_step || displayStatus(props.run.status)}</small>
      </div>
      {props.run.diff_stats?.changedFiles ? (
        <em>
          +{props.run.diff_stats.additions || 0} -{props.run.diff_stats.deletions || 0}
        </em>
      ) : null}
    </button>
  )
}

function AgentComposer(props: {
  run: Run
  session: Session
  onSent: () => Promise<void>
  setError: (value: string) => void
}) {
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const working = ["queued", "starting", "running"].includes(props.run.status)

  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (!prompt.trim() || busy || working) return
    setBusy(true)
    try {
      await apiFetch("/api/agents/run", props.session, {
        method: "POST",
        body: JSON.stringify({ id: props.run.id, action: "continue", prompt }),
      })
      setPrompt("")
      await props.onSent()
    } catch (error) {
      props.setError(error instanceof Error ? error.message : "Vector could not continue the agent.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="agent-composer" onSubmit={send}>
      <textarea
        aria-label="Continue this agent"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={
          working
            ? "This agent is working. You can continue after this run finishes."
            : "Continue this agent in the same isolated workspace..."
        }
        disabled={working}
      />
      <button className="platform-primary" aria-label="Send follow-up" disabled={!prompt.trim() || busy || working}>
        <Send size={14} />
      </button>
    </form>
  )
}

function AgentActivity({ run, connections }: { run: Run; connections: Connection[] }) {
  const tokenTotal = Object.values(run.token_usage || {}).reduce((sum, value) => sum + (Number(value) || 0), 0)
  const steps = [
    ["Workspace created", run.created_at, true],
    ["Agent started", run.started_at, !!run.started_at],
    [run.current_step || "Engineering work", run.updated_at, ["running", "complete", "failed"].includes(run.status)],
    ["Patch ready for review", run.completed_at, run.status === "complete"],
  ] as const

  return (
    <div className="agent-activity">
      <div className="agent-metrics">
        <div>
          <span>Files</span>
          <strong>{run.diff_stats?.changedFiles || 0}</strong>
        </div>
        <div>
          <span>Additions</span>
          <strong className="positive">+{run.diff_stats?.additions || 0}</strong>
        </div>
        <div>
          <span>Deletions</span>
          <strong className="negative">-{run.diff_stats?.deletions || 0}</strong>
        </div>
        <div>
          <span>Tokens</span>
          <strong>{tokenTotal.toLocaleString()}</strong>
        </div>
        <div>
          <span>Cost</span>
          <strong>${(run.cost_usd || 0).toFixed(4)}</strong>
        </div>
      </div>
      <ol>
        {steps.map(([label, time, done], index) => (
          <li key={`${label}-${index}`} data-done={done}>
            <i />
            <div>
              <strong>{label}</strong>
              <span>{time ? formatDate(time) : "Waiting"}</span>
            </div>
          </li>
        ))}
      </ol>
      <div className="agent-tools-used">
        <span>Connected tools</span>
        {run.selected_tools?.length ? (
          run.selected_tools.map((id) => (
            <em key={id}>{connections.find((item) => item.id === id)?.name || "Connected MCP"}</em>
          ))
        ) : (
          <em>No external tools selected</em>
        )}
      </div>
    </div>
  )
}

function AgentChanges({ run }: { run: Run }) {
  if (!run.diff_stats?.files?.length)
    return <div className="agent-inspector-empty">No file changes have been recorded yet.</div>
  return (
    <div className="agent-changes">
      {run.diff_stats.files.map((file) => (
        <div key={file.path}>
          <FileCode2 size={13} />
          <span>{file.path}</span>
          <em>
            <b>+{file.added}</b>
            <i>-{file.deleted}</i>
          </em>
        </div>
      ))}
      {run.diff && (
        <details>
          <summary>Full patch</summary>
          <pre>{run.diff}</pre>
        </details>
      )}
    </div>
  )
}

function ToolPicker(props: {
  connections: Connection[]
  catalog: Tool[]
  selected: string[]
  onToggle: (id: string) => void
}) {
  const readyConnections = props.connections.filter(
    (connection) => connection.enabled && isConnectionCloudReady(connection, props.catalog),
  )

  return (
    <fieldset className="agent-tool-picker">
      <legend>Connected tools</legend>
      {readyConnections.length ? (
        readyConnections.map((connection) => (
          <label key={connection.id}>
            <input
              type="checkbox"
              checked={props.selected.includes(connection.id)}
              onChange={() => props.onToggle(connection.id)}
            />
            <span>{connection.name}</span>
          </label>
        ))
      ) : (
        <p>No cloud-ready connections are enabled. Built-in repository, file, and terminal tools remain available.</p>
      )}
    </fieldset>
  )
}

function CreateAgentModal(props: {
  session: Session
  models: string[]
  teams: Team[]
  connections: Connection[]
  catalog: Tool[]
  onClose: () => void
  onCreated: (run: Run) => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const [repo, setRepo] = useState("")
  const [branch, setBranch] = useState("")
  const [model, setModel] = useModelChoice(props.models)
  const [teamMode, setTeamMode] = useState<"independent" | "existing">("independent")
  const [teamId, setTeamId] = useState(props.teams[0]?.id || "")
  const [tools, setTools] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    setTeamId((current) =>
      current && props.teams.some((team) => team.id === current) ? current : props.teams[0]?.id || "",
    )
  }, [props.teams])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const payload = await apiFetch("/api/agents/runs", props.session, {
        method: "POST",
        body: JSON.stringify({
          name,
          prompt,
          repositoryUrl: repo || undefined,
          repositoryBranch: branch || undefined,
          model,
          teamId: teamMode === "existing" ? teamId : undefined,
          selectedTools: tools,
        }),
      })
      if (!payload.run) throw new Error("Vector created the workspace but did not return its run.")
      props.onCreated(payload.run)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not launch the agent.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AccessibleModal titleId={titleId} descriptionId={descriptionId} onClose={props.onClose}>
      <form className="platform-modal-form" onSubmit={submit}>
        <div className="platform-modal-head">
          <div>
            <h2 id={titleId}>Launch a cloud agent</h2>
            <p id={descriptionId}>Create one isolated workspace for a focused engineering mission.</p>
          </div>
          <button
            className="platform-icon-button"
            type="button"
            aria-label="Close new agent dialog"
            onClick={props.onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="platform-form-grid">
          <label>
            Agent name
            <input
              data-autofocus="true"
              className="platform-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Build authentication"
              maxLength={100}
              required
            />
          </label>
          <label>
            Mission
            <textarea
              className="platform-textarea"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe the result this agent should deliver, including checks it must run."
              maxLength={50_000}
              required
            />
          </label>
          <div className="platform-form-row">
            <label>
              Repository URL (optional)
              <input
                className="platform-input"
                type="url"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="https://github.com/team/repo.git"
              />
            </label>
            <label>
              Branch or tag (optional)
              <input
                className="platform-input"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
              />
            </label>
          </div>
          <label>
            Model
            <select
              className="platform-select"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={!props.models.length}
            >
              {props.models.length ? (
                props.models.map((item) => <option key={item}>{item}</option>)
              ) : (
                <option value="">Cloud model needs configuration</option>
              )}
            </select>
          </label>
          <label>
            Coordination
            <select
              className="platform-select"
              value={teamMode}
              onChange={(event) => setTeamMode(event.target.value as typeof teamMode)}
            >
              <option value="independent">Independent workspace</option>
              {props.teams.length > 0 && <option value="existing">Join an existing team</option>}
            </select>
          </label>
          {teamMode === "existing" && (
            <label>
              Agent team
              <select className="platform-select" value={teamId} onChange={(event) => setTeamId(event.target.value)}>
                {props.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name} · {displayStatus(team.status)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ToolPicker
            connections={props.connections}
            catalog={props.catalog}
            selected={tools}
            onToggle={(id) =>
              setTools((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
            }
          />
          {error && (
            <p className="platform-dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="platform-form-actions">
            <button type="button" className="platform-secondary" onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="platform-primary"
              disabled={busy || !name.trim() || !prompt.trim() || !model || (teamMode === "existing" && !teamId)}
            >
              {busy ? "Creating workspace..." : "Launch agent"}
            </button>
          </div>
        </div>
      </form>
    </AccessibleModal>
  )
}

type MissionDraft = { key: number; name: string; prompt: string }

function CreateTeamModal(props: {
  session: Session
  models: string[]
  connections: Connection[]
  catalog: Tool[]
  onClose: () => void
  onCreated: (payload: TeamCreation) => void
}) {
  const titleId = useId()
  const descriptionId = useId()
  const nextMissionKey = useRef(3)
  const [name, setName] = useState("")
  const [objective, setObjective] = useState("")
  const [repo, setRepo] = useState("")
  const [branch, setBranch] = useState("")
  const [model, setModel] = useModelChoice(props.models)
  const [tools, setTools] = useState<string[]>([])
  const [missions, setMissions] = useState<MissionDraft[]>([
    { key: 1, name: "", prompt: "" },
    { key: 2, name: "", prompt: "" },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const updateMission = (key: number, field: "name" | "prompt", value: string) => {
    setMissions((current) => current.map((mission) => (mission.key === key ? { ...mission, [field]: value } : mission)))
  }

  const addMission = () => {
    if (missions.length >= 16) return
    const key = nextMissionKey.current++
    setMissions((current) => [...current, { key, name: "", prompt: "" }])
  }

  const removeMission = (key: number) => {
    if (missions.length <= 2) return
    setMissions((current) => current.filter((mission) => mission.key !== key))
  }

  const completeMissions = missions.every((mission) => mission.name.trim() && mission.prompt.trim())

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (missions.length < 2 || missions.length > 16 || !completeMissions) return
    setBusy(true)
    setError("")
    try {
      const payload = (await apiFetch("/api/agents/team", props.session, {
        method: "POST",
        body: JSON.stringify({
          name,
          objective,
          repositoryUrl: repo || undefined,
          repositoryBranch: branch || undefined,
          model,
          selectedTools: tools,
          missions: missions.map((mission) => ({ name: mission.name, prompt: mission.prompt })),
        }),
      })) as TeamCreation
      if (!payload.team || !Array.isArray(payload.runs) || !payload.runs.length) {
        throw new Error("Vector created the team but did not return its agent runs.")
      }
      props.onCreated(payload)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not launch the agent team.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AccessibleModal
      className="agent-team-modal"
      titleId={titleId}
      descriptionId={descriptionId}
      onClose={props.onClose}
    >
      <form className="platform-modal-form" onSubmit={submit}>
        <div className="platform-modal-head">
          <div>
            <h2 id={titleId}>Launch an agent team</h2>
            <p id={descriptionId}>Assign 2–16 missions to isolated agents working toward one objective.</p>
          </div>
          <button
            className="platform-icon-button"
            type="button"
            aria-label="Close new team dialog"
            onClick={props.onClose}
          >
            <X size={15} />
          </button>
        </div>
        <div className="platform-form-grid">
          <label>
            Team name
            <input
              data-autofocus="true"
              className="platform-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Authentication launch"
              maxLength={100}
              required
            />
          </label>
          <label>
            Shared objective
            <textarea
              className="platform-textarea"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="Describe the result the team should deliver together and how the work should fit together."
              maxLength={12_000}
              required
            />
          </label>
          <div className="platform-form-row">
            <label>
              Repository URL (optional)
              <input
                className="platform-input"
                type="url"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="https://github.com/team/repo.git"
              />
            </label>
            <label>
              Branch or tag (optional)
              <input
                className="platform-input"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="main"
              />
            </label>
          </div>
          <label>
            Model
            <select
              className="platform-select"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={!props.models.length}
            >
              {props.models.length ? (
                props.models.map((item) => <option key={item}>{item}</option>)
              ) : (
                <option value="">Cloud model needs configuration</option>
              )}
            </select>
          </label>

          <fieldset className="agent-team-missions">
            <legend>
              Agent missions <span>{missions.length}/16</span>
            </legend>
            <div className="agent-team-mission-list">
              {missions.map((mission, index) => (
                <div className="agent-team-mission" key={mission.key}>
                  <div className="agent-team-mission-head">
                    <span>
                      <Bot size={13} />
                      <strong>Agent {index + 1}</strong>
                    </span>
                    <button
                      className="platform-icon-button"
                      type="button"
                      title={`Remove agent ${index + 1}`}
                      aria-label={`Remove agent ${index + 1}`}
                      disabled={missions.length <= 2}
                      onClick={() => removeMission(mission.key)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <label>
                    Agent name
                    <input
                      className="platform-input"
                      value={mission.name}
                      onChange={(event) => updateMission(mission.key, "name", event.target.value)}
                      placeholder="API specialist"
                      maxLength={100}
                      required
                    />
                  </label>
                  <label>
                    Mission
                    <textarea
                      className="platform-textarea agent-mission-textarea"
                      value={mission.prompt}
                      onChange={(event) => updateMission(mission.key, "prompt", event.target.value)}
                      placeholder="Own a distinct part of the shared objective and report the result."
                      maxLength={50_000}
                      required
                    />
                  </label>
                </div>
              ))}
            </div>
            <button
              className="platform-secondary agent-add-mission"
              type="button"
              onClick={addMission}
              disabled={missions.length >= 16}
            >
              <Plus size={14} />
              Add agent
            </button>
          </fieldset>

          <ToolPicker
            connections={props.connections}
            catalog={props.catalog}
            selected={tools}
            onToggle={(id) =>
              setTools((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
            }
          />
          {error && (
            <p className="platform-dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="platform-form-actions agent-team-actions">
            <span>{missions.length} isolated workspaces</span>
            <button type="button" className="platform-secondary" onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="platform-primary"
              disabled={busy || !name.trim() || !objective.trim() || !model || !completeMissions}
            >
              {busy ? `Launching ${missions.length} agents...` : `Launch ${missions.length}-agent team`}
            </button>
          </div>
        </div>
      </form>
    </AccessibleModal>
  )
}

function DeleteRunModal(props: { run: Run; onClose: () => void; onConfirm: () => Promise<void> }) {
  const titleId = useId()
  const descriptionId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const close = () => {
    if (!busy) props.onClose()
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      await props.onConfirm()
      props.onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not delete this workspace.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AccessibleModal className="agent-delete-modal" titleId={titleId} descriptionId={descriptionId} onClose={close}>
      <form className="platform-modal-form" onSubmit={submit}>
        <div className="agent-delete-heading">
          <span>
            <AlertTriangle size={18} />
          </span>
          <div>
            <h2 id={titleId}>Delete cloud workspace?</h2>
            <p id={descriptionId}>
              <strong>{props.run.name}</strong> and its messages, logs, and patch will be permanently removed.
            </p>
          </div>
        </div>
        {activeStatuses.includes(props.run.status) && (
          <p className="agent-delete-note">The running agent will be stopped before its workspace is deleted.</p>
        )}
        {error && (
          <p className="platform-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="platform-form-actions">
          <button data-autofocus="true" type="button" className="platform-secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="platform-danger" disabled={busy}>
            <Trash2 size={14} />
            {busy ? "Deleting..." : "Delete workspace"}
          </button>
        </div>
      </form>
    </AccessibleModal>
  )
}

function ToolsModal(props: {
  session: Session
  connections: Connection[]
  catalog: Tool[]
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const titleId = useId()
  const descriptionId = useId()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Tool>()
  const [values, setValues] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState(false)
  const [customName, setCustomName] = useState("")
  const [customUrl, setCustomUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [confirmingId, setConfirmingId] = useState("")
  const [removingId, setRemovingId] = useState("")
  const [error, setError] = useState("")
  const filtered = props.catalog.filter((tool) =>
    `${tool.name} ${tool.category} ${tool.description}`.toLowerCase().includes(search.toLowerCase()),
  )
  const fieldsComplete = selected?.fields?.every((field) => values[field.key]?.trim()) ?? true

  const resetEditor = () => {
    setSelected(undefined)
    setValues({})
    setCustom(false)
    setCustomName("")
    setCustomUrl("")
    setError("")
  }

  const save = async () => {
    if (!custom && (!selected || !isToolCloudReady(selected))) return
    setBusy(true)
    setError("")
    try {
      await apiFetch("/api/platform/connections", props.session, {
        method: "POST",
        body: JSON.stringify(
          custom
            ? { kind: "mcp_remote", name: customName, url: customUrl }
            : { kind: "plugin", name: selected!.name, pluginId: selected!.id, values },
        ),
      })
      resetEditor()
      await props.onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not save the connection.")
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setRemovingId(id)
    setError("")
    try {
      await apiFetch("/api/platform/connections", props.session, { method: "DELETE", body: JSON.stringify({ id }) })
      setConfirmingId("")
      await props.onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not remove the connection.")
    } finally {
      setRemovingId("")
    }
  }

  return (
    <AccessibleModal className="tools-modal" titleId={titleId} descriptionId={descriptionId} onClose={props.onClose}>
      <div className="platform-modal-head">
        <div>
          <h2 id={titleId}>Cloud integrations</h2>
          <p id={descriptionId}>
            Token, no-auth, and remote MCP connections can run in cloud workspaces. OAuth-only connectors are
            unavailable here.
          </p>
        </div>
        <button
          className="platform-icon-button"
          type="button"
          aria-label="Close integrations dialog"
          onClick={props.onClose}
        >
          <X size={15} />
        </button>
      </div>

      <div className="tools-saved">
        {props.connections.map((connection) => {
          const tool = props.catalog.find((item) => item.id === connection.plugin_id)
          const cloudReady = isConnectionCloudReady(connection, props.catalog)
          const state = !connection.enabled
            ? "Disabled"
            : cloudReady
              ? "Cloud ready"
              : tool?.auth === "oauth"
                ? "Cloud OAuth unavailable"
                : "Not cloud-ready"
          const confirming = confirmingId === connection.id
          return (
            <div className="tools-saved-row" key={connection.id} data-confirming={confirming}>
              <Link2 size={13} />
              <span>
                <strong>{connection.name}</strong>
                <small>{connection.kind.replace("_", " ")}</small>
              </span>
              <em data-ready={cloudReady && connection.enabled}>{state}</em>
              <span className="tools-remove-actions">
                {confirming ? (
                  <>
                    <small>Remove?</small>
                    <button
                      type="button"
                      title="Cancel removal"
                      aria-label={`Keep ${connection.name}`}
                      onClick={() => setConfirmingId("")}
                      disabled={!!removingId}
                    >
                      <X size={13} />
                    </button>
                    <button
                      className="tools-confirm-remove"
                      type="button"
                      title="Confirm removal"
                      aria-label={`Remove ${connection.name}`}
                      onClick={() => void remove(connection.id)}
                      disabled={!!removingId}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    title="Remove connection"
                    aria-label={`Remove ${connection.name}`}
                    onClick={() => setConfirmingId(connection.id)}
                    disabled={!!removingId}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </span>
            </div>
          )
        })}
        {!props.connections.length && <p className="tools-saved-empty">No cloud connections configured.</p>}
      </div>
      {error && (
        <p className="platform-dialog-error" role="alert">
          {error}
        </p>
      )}

      {selected || custom ? (
        <div className="tools-connect">
          <button className="tools-back" type="button" onClick={resetEditor}>
            Back to catalog
          </button>
          <h3>{custom ? "Connect custom MCP" : `Connect ${selected?.name}`}</h3>
          {custom ? (
            <>
              <label>
                Name
                <input
                  data-autofocus="true"
                  className="platform-input"
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                  maxLength={100}
                  required
                />
              </label>
              <label>
                HTTPS MCP URL
                <input
                  className="platform-input"
                  type="url"
                  value={customUrl}
                  onChange={(event) => setCustomUrl(event.target.value)}
                  placeholder="https://mcp.example.com"
                  required
                />
              </label>
            </>
          ) : (
            selected?.fields?.map((field, index) => (
              <label key={field.key}>
                {field.label}
                <input
                  data-autofocus={index === 0 ? "true" : undefined}
                  className="platform-input"
                  type={field.secret ? "password" : "text"}
                  value={values[field.key] || ""}
                  onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                  required
                />
              </label>
            ))
          )}
          <button
            className="platform-primary"
            type="button"
            onClick={() => void save()}
            disabled={busy || (custom ? !customName.trim() || !customUrl.trim() : !fieldsComplete)}
          >
            {busy ? "Saving..." : "Save connection"}
          </button>
        </div>
      ) : (
        <>
          <div className="tools-search">
            <Search size={14} />
            <input
              data-autofocus="true"
              aria-label="Search cloud integrations"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search ${props.catalog.length || "cloud"} integrations`}
            />
            <button type="button" onClick={() => setCustom(true)}>
              Custom MCP
            </button>
          </div>
          <div className="tools-catalog">
            {filtered.map((tool) => {
              const installed = props.connections.some((connection) => connection.plugin_id === tool.id)
              const cloudReady = isToolCloudReady(tool)
              const state = !cloudReady
                ? "Unavailable in cloud"
                : installed
                  ? "Connected"
                  : tool.auth === "none"
                    ? "Enable"
                    : "Connect"
              return (
                <button
                  type="button"
                  key={tool.id}
                  onClick={() => {
                    if (!installed && cloudReady) setSelected(tool)
                  }}
                  disabled={installed || !cloudReady}
                  title={!cloudReady ? tool.cloudNote : undefined}
                >
                  <span className="tool-letter">{tool.name.slice(0, 1)}</span>
                  <span>
                    <strong>{tool.name}</strong>
                    <small>{tool.description}</small>
                  </span>
                  <em data-ready={cloudReady}>{state}</em>
                </button>
              )
            })}
            {!filtered.length && <p className="tools-catalog-empty">No integrations match this search.</p>}
          </div>
        </>
      )}
    </AccessibleModal>
  )
}
