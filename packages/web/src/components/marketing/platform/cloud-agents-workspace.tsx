/** @jsxImportSource react */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import type { Session } from "@supabase/supabase-js"
import {
  Activity,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Cloud,
  Folder,
  KeyRound,
  Laptop,
  Link2,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react"
import { apiFetch, formatDate, formatDuration, type PlatformConfig } from "./platform-client"

type Project = {
  id: string
  name: string
  description: string
  status: "active" | "archived"
  created_at: string
  updated_at: string
}

type Task = {
  id: string
  project_id?: string | null
  name: string
  objective: string
  mode: "coordinated" | "isolated"
  status: string
  created_at: string
  updated_at: string
}

type Run = {
  id: string
  team_id?: string | null
  role?: "worker" | "integrator"
  name: string
  prompt: string
  provider?: string | null
  model: string
  status: string
  current_step?: string | null
  selected_tools: string[]
  summary?: string | null
  logs?: string | null
  error?: string | null
  token_usage?: Record<string, number> | null
  cost_usd?: number | null
  started_at?: string | null
  completed_at?: string | null
  created_at: string
  updated_at: string
}

type Message = { id: string; role: string; content: string; created_at: string }
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
type TeamCreation = { team: Task; runs: Run[]; failures?: Array<{ id: string; message: string }> }
type Notice = { tone: "error" | "success"; message: string }
type AgentDraft = { key: number; name: string; prompt: string }
type WorkspacePayload = { runs: Run[]; teams: Task[]; models: string[] }
type ProjectsPayload = { projects: Project[] }
type ConnectionsPayload = { connections: Connection[] }
type CatalogPayload = { tools: Tool[] }
type RunPayload = { run: Run; messages: Message[] }
type ProviderCatalogItem = {
  id: string
  name: string
  models: string[]
}
type ProviderConnection = {
  id: string
  provider_id: string
  name: string
  models: string[]
  enabled: boolean
  last_status: string
}
type ProvidersPayload = { catalog: ProviderCatalogItem[]; connections: ProviderConnection[] }
type CompanionDevice = {
  id: string
  name: string
  platform: string
  permissions: string[]
  status: string
  last_seen_at?: string | null
  created_at: string
}
type DevicesPayload = { devices: CompanionDevice[] }

const activeStatuses = ["queued", "starting", "running", "needs_input"]

function labelStatus(value: string) {
  return value.replaceAll("_", " ")
}

function taskStatus(task: Task, runs: Run[]) {
  if (runs.some((run) => activeStatuses.includes(run.status))) return "running"
  if (task.status === "integrating") return "coordinating"
  if (runs.some((run) => run.status === "failed")) return "needs attention"
  if (runs.length && runs.every((run) => ["complete", "canceled"].includes(run.status))) return "complete"
  return labelStatus(task.status)
}

function mergeById<T extends { id: string }>(incoming: T[], current: T[]) {
  const ids = new Set(incoming.map((item) => item.id))
  return [...incoming, ...current.filter((item) => !ids.has(item.id))]
}

function toolIsReady(tool?: Tool) {
  return tool?.cloudSupport === "ready"
}

function connectionIsReady(connection: Connection, catalog: Tool[]) {
  if (connection.kind !== "plugin") return true
  if (connection.plugin_id === "computer-use") return true
  return toolIsReady(catalog.find((tool) => tool.id === connection.plugin_id))
}

function providerModels(connection?: ProviderConnection) {
  if (!connection) return []
  return connection.models.map((model) =>
    model.startsWith(`${connection.provider_id}/`) ? model : `${connection.provider_id}/${model}`,
  )
}

function AccessibleModal(props: { children: ReactNode; titleId: string; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("[data-autofocus='true']")?.focus())
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        closeRef.current()
      }
    }
    document.addEventListener("keydown", keydown)
    return () => {
      document.removeEventListener("keydown", keydown)
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [])

  return (
    <div
      className="platform-modal-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <div
        ref={ref}
        className={`platform-modal cloud-modal${props.wide ? " cloud-modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.titleId}
      >
        {props.children}
      </div>
    </div>
  )
}

export function CloudAgentsWorkspace(props: { session: Session; config?: PlatformConfig }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [models, setModels] = useState<string[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [catalog, setCatalog] = useState<Tool[]>([])
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogItem[]>([])
  const [providers, setProviders] = useState<ProviderConnection[]>([])
  const [devices, setDevices] = useState<CompanionDevice[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [selectedTaskId, setSelectedTaskId] = useState("")
  const [selectedRunId, setSelectedRunId] = useState("")
  const selectedRunIdRef = useRef("")
  const [selectedRun, setSelectedRun] = useState<Run>()
  const [messages, setMessages] = useState<Message[]>([])
  const [search, setSearch] = useState("")
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [projectModal, setProjectModal] = useState(false)
  const [taskModal, setTaskModal] = useState(false)
  const [agentModal, setAgentModal] = useState(false)
  const [toolsModal, setToolsModal] = useState(false)
  const [providersModal, setProvidersModal] = useState(false)
  const [devicesModal, setDevicesModal] = useState(false)
  const [busy, setBusy] = useState("")
  const [notice, setNotice] = useState<Notice>()

  const reportError = (cause: unknown, fallback: string) => {
    setNotice({ tone: "error", message: cause instanceof Error ? cause.message : fallback })
  }

  const loadWorkspace = async () => {
    try {
      const [agentData, projectData] = await Promise.all([
        apiFetch<WorkspacePayload>("/api/agents/runs", props.session),
        apiFetch<ProjectsPayload>("/api/agents/projects", props.session),
      ])
      setRuns(agentData.runs || [])
      setTasks(agentData.teams || [])
      setModels(agentData.models || [])
      setProjects((projectData.projects || []).filter((project: Project) => project.status === "active"))
    } catch (cause) {
      reportError(cause, "Vector could not load Cloud Agents.")
    }
  }

  const loadConnections = async () => {
    try {
      const [saved, available, modelProviders, pairedDevices] = await Promise.all([
        apiFetch<ConnectionsPayload>("/api/platform/connections", props.session),
        apiFetch<CatalogPayload>("/api/platform/catalog", props.session),
        apiFetch<ProvidersPayload>("/api/platform/providers", props.session),
        apiFetch<DevicesPayload>("/api/platform/devices", props.session),
      ])
      setConnections(saved.connections || [])
      setCatalog(available.tools || [])
      setProviders(modelProviders.connections || [])
      setProviderCatalog(modelProviders.catalog || [])
      setDevices(pairedDevices.devices || [])
    } catch (cause) {
      reportError(cause, "Vector could not load integrations.")
    }
  }

  const loadRun = async (id = selectedRunIdRef.current) => {
    if (!id) return
    try {
      const payload = await apiFetch<RunPayload>(`/api/agents/run?id=${encodeURIComponent(id)}`, props.session)
      if (!payload.run || id !== selectedRunIdRef.current) return
      setSelectedRun(payload.run)
      setMessages(payload.messages || [])
      setRuns((current) => current.map((run) => (run.id === payload.run.id ? payload.run : run)))
    } catch (cause) {
      if (id === selectedRunIdRef.current) reportError(cause, "Vector could not refresh this agent.")
    }
  }

  useEffect(() => {
    void Promise.all([loadWorkspace(), loadConnections()])
  }, [props.session.access_token])

  useEffect(() => {
    const available = projects.some((project) => project.id === selectedProjectId)
    if (!available) setSelectedProjectId(projects[0]?.id || "")
  }, [projects, selectedProjectId])

  const projectTasks = useMemo(
    () => tasks.filter((task) => task.project_id === selectedProjectId),
    [tasks, selectedProjectId],
  )

  useEffect(() => {
    if (!projectTasks.some((task) => task.id === selectedTaskId)) setSelectedTaskId(projectTasks[0]?.id || "")
  }, [projectTasks, selectedTaskId])

  const taskRuns = useMemo(() => runs.filter((run) => run.team_id === selectedTaskId), [runs, selectedTaskId])

  useEffect(() => {
    if (!taskRuns.some((run) => run.id === selectedRunId)) {
      const preferred = taskRuns.find((run) => run.role === "worker") || taskRuns[0]
      setSelectedRunId(preferred?.id || "")
    }
  }, [taskRuns, selectedRunId])

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId
    if (!selectedRunId) {
      setSelectedRun(undefined)
      setMessages([])
      return
    }
    setSelectedRun(runs.find((run) => run.id === selectedRunId))
    setMessages([])
    void loadRun(selectedRunId)
  }, [selectedRunId])

  useEffect(() => {
    if (!runs.some((run) => activeStatuses.includes(run.status))) return undefined
    const timer = window.setInterval(() => {
      void loadWorkspace()
      void loadRun()
    }, 2800)
    return () => window.clearInterval(timer)
  }, [runs.some((run) => activeStatuses.includes(run.status))])

  useEffect(() => {
    if (!selectedProjectId) return
    setExpandedProjects((current) => new Set(current).add(selectedProjectId))
  }, [selectedProjectId])

  const selectedProject = projects.find((project) => project.id === selectedProjectId)
  const selectedTask = tasks.find((task) => task.id === selectedTaskId)
  const filteredProjects = projects.filter((project) => {
    const haystack = [project.name, ...tasks.filter((task) => task.project_id === project.id).map((task) => task.name)]
      .join(" ")
      .toLowerCase()
    return haystack.includes(search.toLowerCase())
  })

  const chooseTask = (projectId: string, taskId: string) => {
    setSelectedProjectId(projectId)
    setSelectedTaskId(taskId)
    const run = runs.find((item) => item.team_id === taskId && item.role === "worker")
    setSelectedRunId(run?.id || "")
  }

  const changeMode = async (mode: Task["mode"]) => {
    if (!selectedTask || selectedTask.mode === mode) return
    setBusy("mode")
    try {
      const payload = await apiFetch<{ task: Task }>("/api/agents/team", props.session, {
        method: "PATCH",
        body: JSON.stringify({ id: selectedTask.id, mode }),
      })
      setTasks((current) => current.map((task) => (task.id === selectedTask.id ? payload.task : task)))
    } catch (cause) {
      reportError(cause, "Vector could not change how these agents collaborate.")
    } finally {
      setBusy("")
    }
  }

  const stopRun = async () => {
    if (!selectedRun) return
    setBusy("stop")
    try {
      await apiFetch("/api/agents/run", props.session, {
        method: "POST",
        body: JSON.stringify({ id: selectedRun.id, action: "stop" }),
      })
      await Promise.all([loadWorkspace(), loadRun()])
    } catch (cause) {
      reportError(cause, "Vector could not stop this agent.")
    } finally {
      setBusy("")
    }
  }

  const deleteRun = async () => {
    if (!selectedRun || !confirm(`Delete ${selectedRun.name} and its cloud workspace?`)) return
    setBusy("delete")
    try {
      await apiFetch("/api/agents/run", props.session, {
        method: "DELETE",
        body: JSON.stringify({ id: selectedRun.id }),
      })
      setSelectedRunId("")
      await loadWorkspace()
      setNotice({ tone: "success", message: `${selectedRun.name} was deleted.` })
    } catch (cause) {
      reportError(cause, "Vector could not delete this agent.")
    } finally {
      setBusy("")
    }
  }

  return (
    <div className="platform-page cloud-agents-page">
      <header className="cloud-agents-topbar">
        <div className="cloud-agents-title">
          <span>
            <Cloud size={16} />
          </span>
          <div>
            <strong>Cloud Agents</strong>
            <small>{selectedProject ? selectedProject.name : "Projects and autonomous tasks"}</small>
          </div>
        </div>
        <div className="cloud-agents-actions">
          <span className="platform-status" data-state={props.config?.services.cloudAgents ? "active" : "failed"}>
            {props.config?.services.cloudAgents ? "runtime ready" : "setup required"}
          </span>
          <button
            className="platform-icon-button"
            title="Refresh"
            aria-label="Refresh Cloud Agents"
            onClick={() => void loadWorkspace()}
          >
            <RefreshCw size={14} />
          </button>
          <button className="platform-secondary" onClick={() => setToolsModal(true)}>
            <Boxes size={14} /> MCP & plugins
          </button>
          <button className="platform-secondary" onClick={() => setProvidersModal(true)}>
            <KeyRound size={14} /> Model providers
          </button>
          <button className="platform-secondary" onClick={() => setDevicesModal(true)}>
            <Laptop size={14} /> Computer access
          </button>
          <button className="platform-primary" onClick={() => setProjectModal(true)}>
            <Plus size={14} /> New project
          </button>
        </div>
      </header>

      <div className="cloud-workspace-shell">
        <aside className="cloud-project-sidebar">
          <button className="cloud-new-task" disabled={!selectedProject} onClick={() => setTaskModal(true)}>
            <MessageSquare size={15} /> New task
          </button>
          <label className="cloud-project-search">
            <Search size={13} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search projects and tasks"
            />
          </label>
          <div className="cloud-project-list">
            {filteredProjects.map((project) => {
              const childTasks = tasks.filter((task) => task.project_id === project.id)
              const expanded = expandedProjects.has(project.id)
              return (
                <section key={project.id} data-active={project.id === selectedProjectId}>
                  <button
                    className="cloud-project-row"
                    onClick={() => {
                      setSelectedProjectId(project.id)
                      setExpandedProjects((current) => {
                        const next = new Set(current)
                        if (next.has(project.id)) next.delete(project.id)
                        else next.add(project.id)
                        return next
                      })
                    }}
                  >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <Folder size={14} />
                    <strong>{project.name}</strong>
                    <small>{childTasks.length}</small>
                  </button>
                  {expanded && (
                    <div className="cloud-task-list">
                      {childTasks.map((task) => {
                        const agents = runs.filter((run) => run.team_id === task.id)
                        const status = taskStatus(task, agents)
                        return (
                          <button
                            key={task.id}
                            data-active={task.id === selectedTaskId}
                            onClick={() => chooseTask(project.id, task.id)}
                          >
                            <i data-status={status} />
                            <span>
                              <strong>{task.name}</strong>
                              <small>
                                {status} · {agents.filter((run) => run.role !== "integrator").length} agents
                              </small>
                            </span>
                          </button>
                        )
                      })}
                      <button
                        className="cloud-inline-new"
                        onClick={() => {
                          setSelectedProjectId(project.id)
                          setTaskModal(true)
                        }}
                      >
                        <Plus size={12} /> New task
                      </button>
                    </div>
                  )}
                </section>
              )
            })}
            {!projects.length && (
              <div className="cloud-project-empty">
                <Folder size={20} />
                <strong>No projects yet</strong>
                <span>Create a project, then give its agents a task.</span>
              </div>
            )}
          </div>
        </aside>

        <main className="cloud-task-workspace">
          {!selectedProject ? (
            <CloudEmpty
              icon={<Sparkles size={28} />}
              title="Launch your cloud team"
              copy="Create a project to organize tasks, agents, connected tools, and results in one place."
              action="Create project"
              onAction={() => setProjectModal(true)}
            />
          ) : !selectedTask ? (
            <CloudEmpty
              icon={<MessageSquare size={28} />}
              title={`Start work in ${selectedProject.name}`}
              copy="Create a task, decide whether its agents work independently or coordinate, and watch every conversation live."
              action="New task"
              onAction={() => setTaskModal(true)}
            />
          ) : (
            <>
              <div className="cloud-task-header">
                <div>
                  <span className="cloud-breadcrumb">{selectedProject.name} / task</span>
                  <div className="cloud-task-heading">
                    <h1>{selectedTask.name}</h1>
                    <span className="platform-status" data-state={taskStatus(selectedTask, taskRuns)}>
                      {taskStatus(selectedTask, taskRuns)}
                    </span>
                  </div>
                  <p>{selectedTask.objective}</p>
                </div>
                <div className="cloud-task-controls">
                  <div className="cloud-mode-switch" aria-label="Agent collaboration mode">
                    <button
                      data-active={selectedTask.mode === "isolated"}
                      disabled={busy === "mode"}
                      onClick={() => void changeMode("isolated")}
                    >
                      Work alone
                    </button>
                    <button
                      data-active={selectedTask.mode === "coordinated"}
                      disabled={busy === "mode"}
                      onClick={() => void changeMode("coordinated")}
                    >
                      Work together
                    </button>
                  </div>
                  <button
                    className="platform-primary"
                    onClick={() => setAgentModal(true)}
                    disabled={taskRuns.filter((run) => run.role !== "integrator").length >= 16}
                  >
                    <Plus size={14} /> Add agent
                  </button>
                </div>
              </div>

              <div className="cloud-agent-tabs" role="tablist" aria-label="Task agents">
                {taskRuns.map((run) => (
                  <button
                    key={run.id}
                    role="tab"
                    aria-selected={run.id === selectedRunId}
                    data-active={run.id === selectedRunId}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    {activeStatuses.includes(run.status) ? (
                      <LoaderCircle className="cloud-agent-spin" size={13} />
                    ) : run.role === "integrator" ? (
                      <Users size={13} />
                    ) : (
                      <Bot size={13} />
                    )}
                    <span>{run.role === "integrator" ? "Coordinator" : run.name}</span>
                    <i data-status={run.status} />
                  </button>
                ))}
                <button
                  className="cloud-add-agent-tab"
                  title="Add agent"
                  aria-label="Add agent"
                  onClick={() => setAgentModal(true)}
                >
                  <Plus size={13} />
                </button>
              </div>

              {selectedRun ? (
                <section className="cloud-conversation">
                  <div className="cloud-run-meta">
                    <div>
                      <span>
                        <Bot size={12} /> {selectedRun.model}
                      </span>
                      <span>
                        <Activity size={12} /> {selectedRun.current_step || labelStatus(selectedRun.status)}
                      </span>
                      <span>{formatDuration(selectedRun.started_at, selectedRun.completed_at)}</span>
                    </div>
                    <div>
                      {activeStatuses.includes(selectedRun.status) && (
                        <button
                          className="platform-secondary"
                          onClick={() => void stopRun()}
                          disabled={busy === "stop"}
                        >
                          <CircleStop size={13} /> Stop
                        </button>
                      )}
                      <button
                        className="platform-icon-button"
                        title="Delete agent"
                        aria-label="Delete agent"
                        onClick={() => void deleteRun()}
                        disabled={!!busy}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="cloud-message-scroll">
                    <article className="cloud-task-prompt">
                      <header>
                        <span>You</span>
                        <time>{formatDate(selectedRun.created_at)}</time>
                      </header>
                      <p>{selectedRun.prompt}</p>
                    </article>
                    {messages
                      .filter(
                        (message, index) =>
                          !(index === 0 && message.role === "user" && message.content === selectedRun.prompt),
                      )
                      .map((message) => (
                        <article key={message.id} data-role={message.role}>
                          <header>
                            <span>
                              {message.role === "user"
                                ? "You"
                                : selectedRun.role === "integrator"
                                  ? "Vector Coordinator"
                                  : selectedRun.name}
                            </span>
                            <time>{formatDate(message.created_at)}</time>
                          </header>
                          <p>{message.content}</p>
                        </article>
                      ))}
                    {selectedRun.error && (
                      <div className="cloud-run-error">
                        <strong>Agent needs attention</strong>
                        <p>{selectedRun.error}</p>
                      </div>
                    )}
                    {activeStatuses.includes(selectedRun.status) && (
                      <div className="cloud-agent-working">
                        <i />
                        <span>{selectedRun.current_step || "Agent is working"}</span>
                      </div>
                    )}
                    {(selectedRun.logs || selectedRun.summary) && (
                      <details className="cloud-run-details">
                        <summary>Run details and evidence</summary>
                        <pre>{selectedRun.logs || selectedRun.summary}</pre>
                      </details>
                    )}
                  </div>
                  <AgentComposer
                    run={selectedRun}
                    session={props.session}
                    onSent={() => loadRun(selectedRun.id)}
                    onError={(message) => setNotice({ tone: "error", message })}
                  />
                </section>
              ) : (
                <CloudEmpty
                  icon={<Bot size={28} />}
                  title="Add the first agent"
                  copy="Each agent gets a persistent isolated workspace and can use the task's connected tools."
                  action="Add agent"
                  onAction={() => setAgentModal(true)}
                />
              )}
            </>
          )}
        </main>
      </div>

      {notice && (
        <div className="agents-toast" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.message}</span>
          <button aria-label="Dismiss" onClick={() => setNotice(undefined)}>
            <X size={14} />
          </button>
        </div>
      )}
      {projectModal && (
        <ProjectModal
          session={props.session}
          onClose={() => setProjectModal(false)}
          onCreated={(project) => {
            setProjects((current) => [project, ...current])
            setSelectedProjectId(project.id)
            setProjectModal(false)
            setNotice({ tone: "success", message: `${project.name} is ready.` })
          }}
        />
      )}
      {taskModal && selectedProject && (
        <TaskModal
          session={props.session}
          project={selectedProject}
          models={models}
          providers={providers}
          connections={connections}
          catalog={catalog}
          onClose={() => setTaskModal(false)}
          onCreated={(payload) => {
            setTasks((current) => mergeById([payload.team], current))
            setRuns((current) => mergeById(payload.runs, current))
            setSelectedTaskId(payload.team.id)
            setSelectedRunId(payload.runs[0]?.id || "")
            setTaskModal(false)
            setNotice({
              tone: payload.failures?.length ? "error" : "success",
              message: payload.failures?.length
                ? `${payload.team.name} launched, but ${payload.failures.length} agents failed to start.`
                : `${payload.team.name} launched with ${payload.runs.length} agent${payload.runs.length === 1 ? "" : "s"}.`,
            })
            void loadWorkspace()
          }}
        />
      )}
      {agentModal && selectedTask && (
        <NewAgentModal
          session={props.session}
          task={selectedTask}
          models={models}
          providers={providers}
          connections={connections}
          catalog={catalog}
          onClose={() => setAgentModal(false)}
          onCreated={(run) => {
            setRuns((current) => mergeById([run], current))
            setSelectedRunId(run.id)
            setAgentModal(false)
            setNotice({ tone: "success", message: `${run.name} is launching.` })
            void loadWorkspace()
          }}
        />
      )}
      {toolsModal && (
        <CloudToolsModal
          session={props.session}
          connections={connections}
          catalog={catalog}
          onClose={() => setToolsModal(false)}
          onChanged={loadConnections}
        />
      )}
      {providersModal && (
        <CloudProvidersModal
          session={props.session}
          catalog={providerCatalog}
          connections={providers}
          onClose={() => setProvidersModal(false)}
          onChanged={loadConnections}
        />
      )}
      {devicesModal && (
        <ComputerAccessModal
          session={props.session}
          devices={devices}
          onClose={() => setDevicesModal(false)}
          onChanged={loadConnections}
        />
      )}
    </div>
  )
}

function CloudEmpty(props: { icon: ReactNode; title: string; copy: string; action: string; onAction: () => void }) {
  return (
    <div className="cloud-main-empty">
      <span>{props.icon}</span>
      <h2>{props.title}</h2>
      <p>{props.copy}</p>
      <button className="platform-primary" onClick={props.onAction}>
        <Plus size={14} /> {props.action}
      </button>
    </div>
  )
}

function AgentComposer(props: {
  run: Run
  session: Session
  onSent: () => Promise<void>
  onError: (message: string) => void
}) {
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const working = activeStatuses.includes(props.run.status)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!value.trim() || busy || working) return
    setBusy(true)
    try {
      await apiFetch("/api/agents/run", props.session, {
        method: "POST",
        body: JSON.stringify({ id: props.run.id, action: "continue", prompt: value }),
      })
      setValue("")
      await props.onSent()
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : "Vector could not continue this agent.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="cloud-agent-composer" onSubmit={submit}>
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        disabled={working}
        placeholder={
          working ? "This agent is working..." : "Message this agent, @mention context, or give it the next step"
        }
      />
      <div>
        <span>{props.run.model}</span>
        <button className="platform-primary" aria-label="Send" disabled={!value.trim() || busy || working}>
          <Send size={15} />
        </button>
      </div>
    </form>
  )
}

function ProjectModal(props: { session: Session; onClose: () => void; onCreated: (project: Project) => void }) {
  const titleId = useId()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const payload = await apiFetch<{ project: Project }>("/api/agents/projects", props.session, {
        method: "POST",
        body: JSON.stringify({ name, description }),
      })
      props.onCreated(payload.project)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not create the project.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <AccessibleModal titleId={titleId} onClose={props.onClose}>
      <form className="platform-modal-form" onSubmit={submit}>
        <ModalHead
          id={titleId}
          title="Create a cloud project"
          copy="Group related tasks, agents, tools, and results."
          onClose={props.onClose}
        />
        <div className="platform-form-grid">
          <label>
            Project name
            <input
              data-autofocus="true"
              className="platform-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Product launch"
              maxLength={100}
              required
            />
          </label>
          <label>
            Description
            <textarea
              className="platform-textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What this project is responsible for."
              maxLength={2000}
            />
          </label>
          {error && <p className="platform-dialog-error">{error}</p>}
          <ModalActions busy={busy} ready={!!name.trim()} onClose={props.onClose} label="Create project" />
        </div>
      </form>
    </AccessibleModal>
  )
}

function ToolPicker(props: {
  connections: Connection[]
  catalog: Tool[]
  selected: string[]
  onToggle: (id: string) => void
}) {
  const ready = props.connections.filter(
    (connection) => connection.enabled && connectionIsReady(connection, props.catalog),
  )
  return (
    <fieldset className="agent-tool-picker">
      <legend>Tools for this task</legend>
      {ready.length ? (
        ready.map((connection) => (
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
        <p>No cloud-ready MCP or plugin connections yet. The agent still has its built-in workspace tools.</p>
      )}
    </fieldset>
  )
}

function TaskModal(props: {
  session: Session
  project: Project
  models: string[]
  providers: ProviderConnection[]
  connections: Connection[]
  catalog: Tool[]
  onClose: () => void
  onCreated: (payload: TeamCreation) => void
}) {
  const titleId = useId()
  const nextKey = useRef(2)
  const [name, setName] = useState("")
  const [objective, setObjective] = useState("")
  const [mode, setMode] = useState<Task["mode"]>("coordinated")
  const availableProviders = props.providers.filter((provider) => provider.enabled)
  const [providerConnectionId, setProviderConnectionId] = useState(availableProviders[0]?.id || "")
  const activeProvider = availableProviders.find((provider) => provider.id === providerConnectionId)
  const availableModels = activeProvider ? providerModels(activeProvider) : props.models
  const [model, setModel] = useState(availableModels[0] || "")
  const [agents, setAgents] = useState<AgentDraft[]>([{ key: 1, name: "", prompt: "" }])
  const [tools, setTools] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    const firstProvider = availableProviders[0]
    if (firstProvider && !availableProviders.some((provider) => provider.id === providerConnectionId)) {
      setProviderConnectionId(firstProvider.id)
      setModel(providerModels(firstProvider)[0] || "")
      return
    }
    if (!availableModels.includes(model)) setModel(availableModels[0] || "")
  }, [props.models, props.providers, providerConnectionId, model])
  const update = (key: number, field: "name" | "prompt", value: string) =>
    setAgents((current) => current.map((agent) => (agent.key === key ? { ...agent, [field]: value } : agent)))
  const complete = agents.every((agent) => agent.name.trim() && agent.prompt.trim())
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!complete) return
    setBusy(true)
    setError("")
    try {
      const payload = await apiFetch<TeamCreation>("/api/agents/team", props.session, {
        method: "POST",
        body: JSON.stringify({
          projectId: props.project.id,
          name,
          objective,
          mode,
          model,
          providerConnectionId: providerConnectionId || undefined,
          selectedTools: tools,
          missions: agents.map(({ name: agentName, prompt }) => ({ name: agentName, prompt })),
        }),
      })
      props.onCreated(payload)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not launch this task.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <AccessibleModal titleId={titleId} onClose={props.onClose} wide>
      <form className="platform-modal-form" onSubmit={submit}>
        <ModalHead
          id={titleId}
          title={`New task in ${props.project.name}`}
          copy="Launch one agent or divide the outcome across a coordinated group."
          onClose={props.onClose}
        />
        <div className="platform-form-grid">
          <label>
            Task name
            <input
              data-autofocus="true"
              className="platform-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Prepare the product launch"
              maxLength={100}
              required
            />
          </label>
          <label>
            Outcome
            <textarea
              className="platform-textarea"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="Describe the finished result and any constraints."
              maxLength={12000}
              required
            />
          </label>
          <div className="cloud-task-modal-row">
            <label>
              How agents work
              <select
                className="platform-select"
                value={mode}
                onChange={(event) => {
                  if (event.target.value === "coordinated" || event.target.value === "isolated") {
                    setMode(event.target.value)
                  }
                }}
              >
                <option value="coordinated">Work together and synthesize one result</option>
                <option value="isolated">Work independently for separate results</option>
              </select>
            </label>
            <label>
              Model provider
              <select
                className="platform-select"
                value={providerConnectionId}
                onChange={(event) => {
                  const id = event.target.value
                  setProviderConnectionId(id)
                  const provider = availableProviders.find((item) => item.id === id)
                  setModel(providerModels(provider)[0] || props.models[0] || "")
                }}
                disabled={!availableProviders.length}
              >
                {availableProviders.length ? (
                  availableProviders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)
                ) : (
                  <option value="">Connect a provider first</option>
                )}
              </select>
            </label>
            <label>
              Model
              <select
                className="platform-select"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={!availableModels.length}
              >
                {availableModels.length ? (
                  availableModels.map((item) => <option key={item}>{item}</option>)
                ) : (
                  <option value="">Cloud model needs setup</option>
                )}
              </select>
            </label>
          </div>
          <fieldset className="cloud-agent-drafts">
            <legend>
              <span>Agents and subagents</span>
              <small>{agents.length}/16</small>
            </legend>
            {agents.map((agent, index) => (
              <div className="cloud-agent-draft" key={agent.key}>
                <span>
                  <Bot size={14} /> Agent {index + 1}
                </span>
                <input
                  className="platform-input"
                  value={agent.name}
                  onChange={(event) => update(agent.key, "name", event.target.value)}
                  placeholder="Research specialist"
                  maxLength={100}
                  required
                />
                <textarea
                  className="platform-textarea"
                  value={agent.prompt}
                  onChange={(event) => update(agent.key, "prompt", event.target.value)}
                  placeholder="What this agent should own and return."
                  maxLength={50000}
                  required
                />
                {agents.length > 1 && (
                  <button
                    type="button"
                    className="platform-icon-button"
                    aria-label={`Remove agent ${index + 1}`}
                    onClick={() => setAgents((current) => current.filter((item) => item.key !== agent.key))}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              className="platform-secondary cloud-add-draft"
              disabled={agents.length >= 16}
              onClick={() => {
                const key = nextKey.current++
                setAgents((current) => [...current, { key, name: "", prompt: "" }])
              }}
            >
              <Plus size={13} /> Add agent
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
          {error && <p className="platform-dialog-error">{error}</p>}
          <ModalActions
            busy={busy}
            ready={!!name.trim() && !!objective.trim() && !!providerConnectionId && !!model && complete}
            onClose={props.onClose}
            label={`Launch ${agents.length} agent${agents.length === 1 ? "" : "s"}`}
          />
        </div>
      </form>
    </AccessibleModal>
  )
}

function NewAgentModal(props: {
  session: Session
  task: Task
  models: string[]
  providers: ProviderConnection[]
  connections: Connection[]
  catalog: Tool[]
  onClose: () => void
  onCreated: (run: Run) => void
}) {
  const titleId = useId()
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const availableProviders = props.providers.filter((provider) => provider.enabled)
  const [providerConnectionId, setProviderConnectionId] = useState(availableProviders[0]?.id || "")
  const activeProvider = availableProviders.find((provider) => provider.id === providerConnectionId)
  const availableModels = activeProvider ? providerModels(activeProvider) : props.models
  const [model, setModel] = useState(availableModels[0] || "")
  const [tools, setTools] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    const firstProvider = availableProviders[0]
    if (firstProvider && !availableProviders.some((provider) => provider.id === providerConnectionId)) {
      setProviderConnectionId(firstProvider.id)
      setModel(providerModels(firstProvider)[0] || "")
      return
    }
    if (!availableModels.includes(model)) setModel(availableModels[0] || "")
  }, [props.models, props.providers, providerConnectionId, model])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const payload = await apiFetch<{ run: Run }>("/api/agents/runs", props.session, {
        method: "POST",
        body: JSON.stringify({
          name,
          prompt,
          model,
          providerConnectionId: providerConnectionId || undefined,
          teamId: props.task.id,
          selectedTools: tools,
        }),
      })
      props.onCreated(payload.run)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not launch this agent.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <AccessibleModal titleId={titleId} onClose={props.onClose}>
      <form className="platform-modal-form" onSubmit={submit}>
        <ModalHead
          id={titleId}
          title={`Add an agent to ${props.task.name}`}
          copy={
            props.task.mode === "coordinated"
              ? "This agent will share the task objective and contribute to the coordinated result."
              : "This agent will work independently inside the same task."
          }
          onClose={props.onClose}
        />
        <div className="platform-form-grid">
          <label>
            Agent name
            <input
              data-autofocus="true"
              className="platform-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Operations specialist"
              maxLength={100}
              required
            />
          </label>
          <label>
            Assignment
            <textarea
              className="platform-textarea"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Give this agent a specific responsibility."
              maxLength={50000}
              required
            />
          </label>
          <label>
            Model provider
            <select
              className="platform-select"
              value={providerConnectionId}
              onChange={(event) => {
                const id = event.target.value
                setProviderConnectionId(id)
                const provider = availableProviders.find((item) => item.id === id)
                setModel(providerModels(provider)[0] || props.models[0] || "")
              }}
              disabled={!availableProviders.length}
            >
              {availableProviders.length ? (
                availableProviders.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)
              ) : (
                <option value="">Connect a provider first</option>
              )}
            </select>
          </label>
          <label>
            Model
            <select
              className="platform-select"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={!availableModels.length}
            >
              {availableModels.length ? (
                availableModels.map((item) => <option key={item}>{item}</option>)
              ) : (
                <option value="">Cloud model needs setup</option>
              )}
            </select>
          </label>
          <ToolPicker
            connections={props.connections}
            catalog={props.catalog}
            selected={tools}
            onToggle={(id) =>
              setTools((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
            }
          />
          {error && <p className="platform-dialog-error">{error}</p>}
          <ModalActions
            busy={busy}
            ready={!!name.trim() && !!prompt.trim() && !!providerConnectionId && !!model}
            onClose={props.onClose}
            label="Launch agent"
          />
        </div>
      </form>
    </AccessibleModal>
  )
}

function ModalHead(props: { id: string; title: string; copy: string; onClose: () => void }) {
  return (
    <div className="platform-modal-head">
      <div>
        <h2 id={props.id}>{props.title}</h2>
        <p>{props.copy}</p>
      </div>
      <button className="platform-icon-button" type="button" aria-label="Close" onClick={props.onClose}>
        <X size={15} />
      </button>
    </div>
  )
}

function ModalActions(props: { busy: boolean; ready: boolean; onClose: () => void; label: string }) {
  return (
    <div className="platform-form-actions">
      <button type="button" className="platform-secondary" onClick={props.onClose}>
        Cancel
      </button>
      <button type="submit" className="platform-primary" disabled={props.busy || !props.ready}>
        {props.busy ? "Working..." : props.label}
      </button>
    </div>
  )
}

function ComputerAccessModal(props: {
  session: Session
  devices: CompanionDevice[]
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const timer = window.setInterval(() => void props.onChanged(), 4_000)
    return () => window.clearInterval(timer)
  }, [])

  const pair = async () => {
    setBusy(true)
    setError("")
    try {
      const payload = await apiFetch<{ url: string }>("/api/platform/devices", props.session, {
        method: "POST",
        body: JSON.stringify({ action: "pair" }),
      })
      window.location.href = payload.url
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not start computer pairing.")
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    setBusy(true)
    setError("")
    try {
      await apiFetch("/api/platform/devices", props.session, {
        method: "DELETE",
        body: JSON.stringify({ id }),
      })
      await props.onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not disconnect this computer.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AccessibleModal titleId={titleId} onClose={props.onClose}>
      <ModalHead
        id={titleId}
        title="Computer access"
        copy="Pair the Vector desktop app, then choose its Computer connection when launching an agent."
        onClose={props.onClose}
      />
      <div className="platform-form-grid">
        <div className="cloud-device-safety">
          <Laptop size={18} />
          <p>
            Cloud Agents cannot act silently. The desktop app displays every requested browser or terminal action and
            requires an explicit <strong>Allow once</strong> before it runs.
          </p>
        </div>
        {props.devices.length ? (
          props.devices.map((device) => {
            const online = device.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() < 30_000
            return (
              <div className="cloud-connected-tool" key={device.id}>
                <Laptop size={15} />
                <span>
                  <strong>{device.name}</strong>
                  <small>{online ? "Online" : "Offline"} · {device.platform} · {device.permissions.join(" + ")}</small>
                </span>
                <button
                  className="platform-secondary"
                  disabled={busy}
                  onClick={() => void revoke(device.id)}
                >
                  Disconnect
                </button>
              </div>
            )
          })
        ) : (
          <p className="cloud-tools-empty">No computers are paired with this account.</p>
        )}
        <button className="platform-primary" onClick={() => void pair()} disabled={busy}>
          <Laptop size={14} /> {busy ? "Preparing..." : "Connect this computer"}
        </button>
        {error && <p className="platform-dialog-error">{error}</p>}
      </div>
    </AccessibleModal>
  )
}

function CloudProvidersModal(props: {
  session: Session
  catalog: ProviderCatalogItem[]
  connections: ProviderConnection[]
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const titleId = useId()
  const [selectedId, setSelectedId] = useState(props.catalog[0]?.id || "")
  const selected = props.catalog.find((provider) => provider.id === selectedId)
  const existing = props.connections.find((provider) => provider.provider_id === selectedId)
  const [apiKey, setApiKey] = useState("")
  const [models, setModels] = useState((existing?.models || selected?.models || []).join("\n"))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const connection = props.connections.find((provider) => provider.provider_id === selectedId)
    const provider = props.catalog.find((item) => item.id === selectedId)
    setApiKey("")
    setModels((connection?.models || provider?.models || []).join("\n"))
  }, [selectedId, props.connections, props.catalog])

  const save = async () => {
    if (!selected) return
    setBusy(true)
    setError("")
    try {
      await apiFetch("/api/platform/providers", props.session, {
        method: "POST",
        body: JSON.stringify({
          id: existing?.id,
          providerId: selected.id,
          name: selected.name,
          apiKey,
          models: models.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
        }),
      })
      setApiKey("")
      await props.onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not save this provider.")
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    setError("")
    try {
      await apiFetch("/api/platform/providers", props.session, { method: "DELETE", body: JSON.stringify({ id }) })
      await props.onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not remove this provider.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <AccessibleModal titleId={titleId} onClose={props.onClose} wide>
      <ModalHead
        id={titleId}
        title="Model providers"
        copy="Bring the same provider keys you use in Vector desktop. Keys are encrypted and brokered into isolated runs."
        onClose={props.onClose}
      />
      <div className="cloud-tools-layout">
        <section>
          <h3>Connected</h3>
          {props.connections.length ? (
            props.connections.map((connection) => (
              <div className="cloud-connected-tool" key={connection.id}>
                <KeyRound size={14} />
                <span>
                  <strong>{connection.name}</strong>
                  <small>{connection.models.length} model{connection.models.length === 1 ? "" : "s"} · {connection.last_status}</small>
                </span>
                <button
                  className="platform-icon-button"
                  aria-label={`Remove ${connection.name}`}
                  onClick={() => void remove(connection.id)}
                  disabled={busy}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <p className="cloud-tools-empty">Connect a provider to launch Cloud Agents.</p>
          )}
        </section>
        <section>
          <h3>BYOK providers</h3>
          <div className="cloud-tool-catalog">
            {props.catalog.map((provider) => (
              <button
                key={provider.id}
                data-selected={selectedId === provider.id}
                onClick={() => setSelectedId(provider.id)}
              >
                <KeyRound size={14} />
                <span>
                  <strong>{provider.name}</strong>
                  <small>{props.connections.some((item) => item.provider_id === provider.id) ? "Connected" : "Use your API key"}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
      {selected && (
        <div className="cloud-tool-editor">
          <h3>{existing ? `Reconnect ${selected.name}` : `Connect ${selected.name}`}</h3>
          <label>
            API key
            <input
              className="platform-input"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={existing ? "Enter a new key to replace the saved key" : "Stored encrypted"}
            />
          </label>
          <label>
            Model IDs
            <textarea
              className="platform-textarea"
              value={models}
              onChange={(event) => setModels(event.target.value)}
              placeholder="One provider model ID per line"
            />
          </label>
          <button
            className="platform-primary"
            onClick={() => void save()}
            disabled={busy || apiKey.trim().length < 8 || !models.trim()}
          >
            {busy ? "Saving..." : existing ? "Replace connection" : "Connect provider"}
          </button>
        </div>
      )}
      {error && <p className="platform-dialog-error">{error}</p>}
    </AccessibleModal>
  )
}

function CloudToolsModal(props: {
  session: Session
  connections: Connection[]
  catalog: Tool[]
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const titleId = useId()
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<Tool>()
  const [values, setValues] = useState<Record<string, string>>({})
  const [custom, setCustom] = useState(false)
  const [customKind, setCustomKind] = useState<"mcp_remote" | "mcp_local">("mcp_remote")
  const [customName, setCustomName] = useState("")
  const [customUrl, setCustomUrl] = useState("")
  const [customHeaders, setCustomHeaders] = useState("")
  const [customCommand, setCustomCommand] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const filtered = props.catalog.filter((tool) =>
    `${tool.name} ${tool.category} ${tool.description}`.toLowerCase().includes(search.toLowerCase()),
  )
  const save = async () => {
    setBusy(true)
    setError("")
    try {
      await apiFetch("/api/platform/connections", props.session, {
        method: "POST",
        body: JSON.stringify(
          custom
            ? customKind === "mcp_remote"
              ? {
                  kind: customKind,
                  name: customName,
                  url: customUrl,
                  headers: Object.fromEntries(
                    customHeaders
                      .split("\n")
                      .map((line) => {
                        const separator = line.indexOf(":")
                        return separator > 0 ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] : []
                      })
                      .filter((entry): entry is [string, string] => entry.length === 2 && Boolean(entry[0]) && Boolean(entry[1])),
                  ),
                }
              : {
                  kind: customKind,
                  name: customName,
                  command: customCommand.split("\n").map((value) => value.trim()).filter(Boolean),
                }
            : { kind: "plugin", name: selected!.name, pluginId: selected!.id, values },
        ),
      })
      setSelected(undefined)
      setValues({})
      setCustom(false)
      setCustomName("")
      setCustomUrl("")
      setCustomHeaders("")
      setCustomCommand("")
      await props.onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not save this connection.")
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: string) => {
    setBusy(true)
    setError("")
    try {
      await apiFetch("/api/platform/connections", props.session, { method: "DELETE", body: JSON.stringify({ id }) })
      await props.onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not remove this connection.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <AccessibleModal titleId={titleId} onClose={props.onClose} wide>
      <ModalHead
        id={titleId}
        title="MCP and plugins"
        copy="Connect tools once, then choose which agents can use them."
        onClose={props.onClose}
      />
      <div className="cloud-tools-layout">
        <section>
          <h3>Connected</h3>
          {props.connections.length ? (
            props.connections.map((connection) => (
              <div className="cloud-connected-tool" key={connection.id}>
                <Link2 size={14} />
                <span>
                  <strong>{connection.name}</strong>
                  <small>
                    {connection.kind.replaceAll("_", " ")} · {connection.last_status}
                  </small>
                </span>
                <button
                  className="platform-icon-button"
                  aria-label={`Remove ${connection.name}`}
                  onClick={() => void remove(connection.id)}
                  disabled={busy}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <p className="cloud-tools-empty">No cloud tools connected yet.</p>
          )}
          <button
            className="platform-secondary"
            onClick={() => {
              setCustom(true)
              setCustomKind("mcp_remote")
              setSelected(undefined)
            }}
          >
            <Plus size={13} /> Remote MCP server
          </button>
          <button
            className="platform-secondary"
            onClick={() => {
              setCustom(true)
              setCustomKind("mcp_local")
              setSelected(undefined)
            }}
          >
            <Plus size={13} /> Local MCP command
          </button>
        </section>
        <section>
          <label className="cloud-project-search">
            <Search size={13} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search plugins" />
          </label>
          <div className="cloud-tool-catalog">
            {filtered.map((tool) => (
              <button
                key={tool.id}
                data-selected={selected?.id === tool.id}
                disabled={!toolIsReady(tool)}
                onClick={() => {
                  setSelected(tool)
                  setCustom(false)
                  setValues({})
                }}
              >
                <Boxes size={14} />
                <span>
                  <strong>{tool.name}</strong>
                  <small>{toolIsReady(tool) ? tool.description : tool.cloudNote}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
      {(selected || custom) && (
        <div className="cloud-tool-editor">
          <h3>
            {custom ? (customKind === "mcp_remote" ? "Connect remote MCP" : "Connect local MCP") : `Connect ${selected?.name}`}
          </h3>
          {custom ? (
            <>
              <label>
                Name
                <input
                  className="platform-input"
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                />
              </label>
              {customKind === "mcp_remote" ? (
                <>
                  <label>
                    Server URL
                    <input
                      className="platform-input"
                      type="url"
                      value={customUrl}
                      onChange={(event) => setCustomUrl(event.target.value)}
                      placeholder="https://example.com/mcp"
                    />
                  </label>
                  <label>
                    Encrypted request headers (optional)
                    <textarea
                      className="platform-textarea"
                      value={customHeaders}
                      onChange={(event) => setCustomHeaders(event.target.value)}
                      placeholder={"Authorization: Bearer token\nX-Workspace: production"}
                    />
                  </label>
                </>
              ) : (
                <label>
                  Command and arguments
                  <textarea
                    className="platform-textarea"
                    value={customCommand}
                    onChange={(event) => setCustomCommand(event.target.value)}
                    placeholder={"npx\n-y\n@modelcontextprotocol/server-filesystem\n/vercel/sandbox/workspace"}
                  />
                  <small>Enter the executable and each argument on its own line. Secret environment values require a remote MCP.</small>
                </label>
              )}
            </>
          ) : (
            selected?.fields?.map((field) => (
              <label key={field.key}>
                {field.label}
                <input
                  className="platform-input"
                  type={field.secret ? "password" : "text"}
                  value={values[field.key] || ""}
                  onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                />
              </label>
            ))
          )}
          <button
            className="platform-primary"
            onClick={() => void save()}
            disabled={
              busy ||
              (custom
                ? !customName.trim() || (customKind === "mcp_remote" ? !customUrl.trim() : !customCommand.trim())
                : !selected || !!selected.fields?.some((field) => !values[field.key]?.trim()))
            }
          >
            Connect
          </button>
        </div>
      )}
      {error && <p className="platform-dialog-error">{error}</p>}
    </AccessibleModal>
  )
}
