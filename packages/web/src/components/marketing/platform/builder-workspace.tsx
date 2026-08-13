/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import type { Session } from "@supabase/supabase-js"
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  ChevronDown,
  Clock3,
  Code2,
  CreditCard,
  Download,
  ExternalLink,
  Folder,
  Globe2,
  LoaderCircle,
  LogOut,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
  Wrench,
} from "lucide-react"
import { apiFetch, formatDate, formatDuration, platformAuth, type PlatformConfig } from "./platform-client"

type BuilderProject = {
  id: string
  name: string
  description: string
  status: "active" | "archived"
  created_at: string
  updated_at: string
}

type BuilderRun = {
  id: string
  project_id: string
  name: string
  prompt: string
  provider: string | null
  model: string
  status: "queued" | "starting" | "running" | "needs_input" | "complete" | "failed" | "canceled"
  current_step: string | null
  selected_tools: string[]
  summary: string | null
  logs: string | null
  diff_stats: {
    files?: Array<{ path: string; added: number; deleted: number }>
    changedFiles?: number
    additions?: number
    deletions?: number
  } | null
  error: string | null
  cost_usd: number | null
  token_usage: Record<string, number> | null
  preview_url: string | null
  preview_status: "idle" | "launching" | "ready" | "failed"
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

type BuilderMessage = {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  created_at: string
}

type ProviderConnection = {
  id: string
  provider_id: string
  name: string
  models: string[]
  enabled: boolean
}

type ToolConnection = {
  id: string
  plugin_id: string | null
  name: string
  kind: "plugin" | "mcp_remote" | "mcp_local"
  enabled: boolean
}

const activeStates = new Set(["queued", "starting", "running", "needs_input"])

function runLabel(run?: BuilderRun) {
  if (!run) return "Not started"
  if (run.status === "queued") return "Queued"
  if (run.status === "starting") return "Preparing workspace"
  if (run.status === "running") return "Building"
  if (run.status === "needs_input") return "Needs input"
  if (run.status === "complete") return "Ready"
  if (run.status === "failed") return "Needs attention"
  return "Stopped"
}

function titleFromPrompt(prompt: string) {
  return (
    prompt
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .join(" ") || "Untitled app"
  )
}

function ProjectMark(props: { name: string }) {
  return <span className="builder-project-mark">{props.name.slice(0, 1).toUpperCase()}</span>
}

export function BuilderWorkspace(props: { session: Session; config?: PlatformConfig }) {
  const [projects, setProjects] = useState<BuilderProject[]>([])
  const [runs, setRuns] = useState<BuilderRun[]>([])
  const [messages, setMessages] = useState<BuilderMessage[]>([])
  const [providers, setProviders] = useState<ProviderConnection[]>([])
  const [connections, setConnections] = useState<ToolConnection[]>([])
  const [models, setModels] = useState<string[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const [selectedRunId, setSelectedRunId] = useState("")
  const [providerId, setProviderId] = useState("")
  const [model, setModel] = useState("")
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [prompt, setPrompt] = useState("")
  const [followUp, setFollowUp] = useState("")
  const [search, setSearch] = useState("")
  const [busy, setBusy] = useState("")
  const [message, setMessage] = useState("")
  const launchedPreviews = useRef(new Set<string>())

  const selectedProject = projects.find((item) => item.id === selectedProjectId)
  const selectedRun = runs.find((item) => item.id === selectedRunId)
  const projectRuns = useMemo(
    () => runs.filter((item) => item.project_id === selectedProjectId),
    [runs, selectedProjectId],
  )
  const filteredProjects = projects.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()))

  const loadOverview = async () => {
    const [projectPayload, runPayload, providerPayload, connectionPayload] = await Promise.all([
      apiFetch<{ projects: BuilderProject[] }>("/api/builder/projects", props.session),
      apiFetch<{ runs: BuilderRun[]; models: string[] }>("/api/builder/runs", props.session),
      apiFetch<{ connections: ProviderConnection[] }>("/api/platform/providers", props.session),
      apiFetch<{ connections: ToolConnection[] }>("/api/platform/connections", props.session),
    ])
    setProjects(projectPayload.projects || [])
    setRuns(runPayload.runs || [])
    setModels(runPayload.models || [])
    setProviders((providerPayload.connections || []).filter((item) => item.enabled))
    setConnections((connectionPayload.connections || []).filter((item) => item.enabled))
  }

  useEffect(() => {
    loadOverview().catch((error) => {
      setMessage(error instanceof Error ? error.message : "Vector Builder could not open.")
    })
  }, [props.session.access_token])

  useEffect(() => {
    const provider = providers.find((item) => item.id === providerId)
    if (!provider) {
      if (!providerId && !model && models[0]) setModel(models[0])
      return
    }
    const next = provider.models[0]
    if (next) setModel(provider.provider_id + "/" + next)
  }, [providerId, providers, models])

  const refreshRun = async (id: string) => {
    const payload = await apiFetch<{ run: BuilderRun; messages: BuilderMessage[] }>(
      "/api/builder/run?id=" + encodeURIComponent(id),
      props.session,
    )
    setRuns((current) => {
      const exists = current.some((item) => item.id === payload.run.id)
      return exists
        ? current.map((item) => (item.id === payload.run.id ? payload.run : item))
        : [payload.run, ...current]
    })
    setMessages(payload.messages || [])
    return payload.run
  }

  useEffect(() => {
    if (!selectedRunId) {
      setMessages([])
      return
    }
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const run = await refreshRun(selectedRunId)
        if (!active) return
        if (activeStates.has(run.status)) timer = setTimeout(poll, 2_500)
      } catch (error) {
        if (active) setMessage(error instanceof Error ? error.message : "Vector could not refresh this build.")
      }
    }
    void poll()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [selectedRunId, props.session.access_token])

  const openProject = (project: BuilderProject) => {
    setSelectedProjectId(project.id)
    const latest = runs.find((item) => item.project_id === project.id)
    setSelectedRunId(latest?.id || "")
    setMessage("")
  }

  const build = async (event: FormEvent) => {
    event.preventDefault()
    const task = prompt.trim()
    if (!task) return
    setBusy("build")
    setMessage("")
    try {
      let projectId = selectedProjectId
      if (!projectId) {
        const created = await apiFetch<{ project: BuilderProject }>("/api/builder/projects", props.session, {
          method: "POST",
          body: JSON.stringify({ name: titleFromPrompt(task), description: task.slice(0, 280) }),
        })
        projectId = created.project.id
        setProjects((current) => [created.project, ...current])
        setSelectedProjectId(projectId)
      }
      const payload = await apiFetch<{ run: BuilderRun }>("/api/builder/runs", props.session, {
        method: "POST",
        body: JSON.stringify({
          projectId,
          name: titleFromPrompt(task),
          prompt: task,
          providerConnectionId: providerId || undefined,
          model: model || undefined,
          selectedTools,
        }),
      })
      setRuns((current) => [payload.run, ...current])
      setSelectedRunId(payload.run.id)
      setPrompt("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not start this build.")
    } finally {
      setBusy("")
    }
  }

  const continueBuild = async (event: FormEvent) => {
    event.preventDefault()
    if (!selectedRun || !followUp.trim()) return
    setBusy("continue")
    setMessage("")
    try {
      await apiFetch("/api/builder/run", props.session, {
        method: "POST",
        body: JSON.stringify({ id: selectedRun.id, action: "continue", prompt: followUp.trim() }),
      })
      setFollowUp("")
      await refreshRun(selectedRun.id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not continue this build.")
    } finally {
      setBusy("")
    }
  }

  const launchPreview = async (run: BuilderRun) => {
    setBusy("preview")
    setMessage("")
    try {
      const payload = await apiFetch<{ preview: { url: string } }>("/api/builder/preview", props.session, {
        method: "POST",
        body: JSON.stringify({ id: run.id }),
      })
      setRuns((current) =>
        current.map((item) =>
          item.id === run.id ? { ...item, preview_url: payload.preview.url, preview_status: "ready" } : item,
        ),
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not launch this preview.")
    } finally {
      setBusy("")
    }
  }

  useEffect(() => {
    if (
      selectedRun &&
      selectedRun.status === "complete" &&
      selectedRun.preview_status === "idle" &&
      !launchedPreviews.current.has(selectedRun.id)
    ) {
      launchedPreviews.current.add(selectedRun.id)
      void launchPreview(selectedRun)
    }
  }, [selectedRun?.id, selectedRun?.status, selectedRun?.preview_status])

  const stop = async () => {
    if (!selectedRun) return
    setBusy("stop")
    try {
      await apiFetch("/api/builder/run", props.session, {
        method: "POST",
        body: JSON.stringify({ id: selectedRun.id, action: "stop" }),
      })
      await refreshRun(selectedRun.id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not stop this build.")
    } finally {
      setBusy("")
    }
  }

  const removeRun = async () => {
    if (!selectedRun) return
    setBusy("delete")
    try {
      await apiFetch("/api/builder/run", props.session, {
        method: "DELETE",
        body: JSON.stringify({ id: selectedRun.id }),
      })
      const remaining = runs.filter((item) => item.id !== selectedRun.id)
      setRuns(remaining)
      setSelectedRunId(remaining.find((item) => item.project_id === selectedProjectId)?.id || "")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Vector could not delete this build.")
    } finally {
      setBusy("")
    }
  }

  const signOut = async () => {
    const auth = await platformAuth()
    await auth.auth.signOut()
    location.assign("/")
  }

  const composer = (
    <form className="builder-composer" onSubmit={build}>
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Describe the app you want Vector to build..."
        rows={3}
      />
      <div className="builder-composer-controls">
        <div>
          <label className="builder-select-control">
            <WandSparkles size={15} />
            <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
              <option value="">Vector model</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            <ChevronDown size={13} />
          </label>
          <details className="builder-tools">
            <summary>
              <Wrench size={15} />
              {selectedTools.length ? selectedTools.length + " tools" : "Tools"}
            </summary>
            <div>
              {connections.length ? (
                connections.map((connection) => (
                  <label key={connection.id}>
                    <input
                      type="checkbox"
                      checked={selectedTools.includes(connection.id)}
                      onChange={(event) =>
                        setSelectedTools((current) =>
                          event.target.checked
                            ? [...current, connection.id]
                            : current.filter((item) => item !== connection.id),
                        )
                      }
                    />
                    <span>{connection.name}</span>
                  </label>
                ))
              ) : (
                <a href="/settings#connections">Connect tools in Settings</a>
              )}
            </div>
          </details>
        </div>
        <button type="submit" aria-label="Build app" disabled={!!busy || !prompt.trim()}>
          {busy === "build" ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={17} />}
        </button>
      </div>
    </form>
  )

  return (
    <div className="builder-shell">
      <aside className="builder-sidebar">
        <a className="builder-brand" href="/">
          <img src="/vector-logo.png" alt="" />
          <strong>Vector</strong>
        </a>
        <button
          className="builder-dashboard-link"
          data-active={!selectedProjectId}
          onClick={() => {
            setSelectedProjectId("")
            setSelectedRunId("")
          }}
        >
          <Sparkles size={16} /> Builder
        </button>
        <div className="builder-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
          />
        </div>
        <div className="builder-sidebar-heading">
          <span>Projects</span>
          <button
            type="button"
            title="New project"
            onClick={() => {
              setSelectedProjectId("")
              setSelectedRunId("")
              setPrompt("")
            }}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="builder-project-list">
          {filteredProjects.map((project) => {
            const latest = runs.find((item) => item.project_id === project.id)
            return (
              <button
                type="button"
                key={project.id}
                data-active={project.id === selectedProjectId}
                onClick={() => openProject(project)}
              >
                <ProjectMark name={project.name} />
                <span>
                  <strong>{project.name}</strong>
                  <small>{latest ? runLabel(latest) : "Ready to build"}</small>
                </span>
                {latest && activeStates.has(latest.status) && <i />}
              </button>
            )
          })}
          {!filteredProjects.length && <p>No projects yet.</p>}
        </div>
        <nav className="builder-account-nav">
          <a href="/download">
            <Download size={15} /> Downloads
          </a>
          <a href="/billing">
            <CreditCard size={15} /> Billing
          </a>
          <a href="/settings">
            <Settings size={15} /> Settings
          </a>
        </nav>
        <div className="builder-user">
          <span>{(props.session.user.email || "V").slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{props.session.user.user_metadata?.full_name || "Vector member"}</strong>
            <small>{props.session.user.email}</small>
          </div>
          <button type="button" title="Sign out" onClick={() => void signOut()}>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      {!selectedRun ? (
        <main className="builder-dashboard">
          <section className="builder-hero">
            <span className="builder-kicker">
              <Bot size={15} /> Vector Builder
            </span>
            <h1>{selectedProject ? "What should Vector change?" : "What will you build?"}</h1>
            <p>
              Describe the product. Vector creates the files, runs the project, and gives you a live app to inspect.
            </p>
            {composer}
            {!providers.length && !models.length && (
              <a className="builder-provider-note" href="/settings#models">
                Connect a model provider to start building <ExternalLink size={13} />
              </a>
            )}
          </section>
          <section className="builder-projects">
            <header>
              <div>
                <h2>Your projects</h2>
                <p>Each project keeps its own builds, conversation, files, and live preview.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedProjectId("")
                  setSelectedRunId("")
                  document.querySelector<HTMLTextAreaElement>(".builder-composer textarea")?.focus()
                }}
              >
                <Plus size={15} /> New project
              </button>
            </header>
            <div className="builder-project-grid">
              {projects.slice(0, 8).map((project) => {
                const latest = runs.find((item) => item.project_id === project.id)
                return (
                  <button type="button" key={project.id} onClick={() => openProject(project)}>
                    <div className="builder-project-preview">
                      <ProjectMark name={project.name} />
                      <span>{latest?.preview_status === "ready" ? "Live preview ready" : "Vector project"}</span>
                    </div>
                    <div>
                      <strong>{project.name}</strong>
                      <small>{latest ? runLabel(latest) : "No builds yet"}</small>
                    </div>
                    <time>{formatDate(project.updated_at)}</time>
                  </button>
                )
              })}
              {!projects.length && (
                <div className="builder-empty">
                  <Code2 size={23} />
                  <strong>Your first working app starts above.</strong>
                  <span>Vector will create the project automatically when you send the prompt.</span>
                </div>
              )}
            </div>
          </section>
        </main>
      ) : (
        <main className="builder-workspace">
          <header className="builder-workspace-topbar">
            <div>
              <button
                type="button"
                title="Back to projects"
                onClick={() => {
                  setSelectedProjectId("")
                  setSelectedRunId("")
                }}
              >
                <ArrowLeft size={16} />
              </button>
              <ProjectMark name={selectedProject?.name || selectedRun.name} />
              <span>
                <strong>{selectedProject?.name || selectedRun.name}</strong>
                <small>{selectedRun.current_step || runLabel(selectedRun)}</small>
              </span>
            </div>
            <div>
              <span className="builder-run-status" data-state={selectedRun.status}>
                {activeStates.has(selectedRun.status) && <i />}
                {runLabel(selectedRun)}
              </span>
              {activeStates.has(selectedRun.status) ? (
                <button type="button" onClick={() => void stop()} disabled={!!busy}>
                  <Square size={14} /> Stop
                </button>
              ) : (
                <button type="button" onClick={() => void launchPreview(selectedRun)} disabled={!!busy}>
                  <RefreshCw size={14} /> {selectedRun.preview_url ? "Restart preview" : "Open preview"}
                </button>
              )}
              <button type="button" className="icon-only" title="Delete build" onClick={() => void removeRun()}>
                <Trash2 size={15} />
              </button>
            </div>
          </header>
          <div className="builder-workspace-body">
            <section className="builder-conversation">
              <div className="builder-conversation-scroll">
                {messages.map((item) => (
                  <article key={item.id} data-role={item.role}>
                    <span>{item.role === "user" ? "You" : "Vector"}</span>
                    <p>{item.content}</p>
                  </article>
                ))}
                {activeStates.has(selectedRun.status) && (
                  <div className="builder-live-step">
                    <LoaderCircle className="spin" size={16} />
                    <span>
                      <strong>{selectedRun.current_step || "Vector is building"}</strong>
                      <small>Changes stream into this workspace while the agent works.</small>
                    </span>
                  </div>
                )}
                {selectedRun.error && <div className="builder-error">{selectedRun.error}</div>}
                {selectedRun.diff_stats?.files?.length ? (
                  <details className="builder-changes">
                    <summary>
                      <Folder size={15} />
                      {selectedRun.diff_stats.changedFiles || selectedRun.diff_stats.files.length} files changed
                      <span>
                        +{selectedRun.diff_stats.additions || 0} -{selectedRun.diff_stats.deletions || 0}
                      </span>
                    </summary>
                    <div>
                      {selectedRun.diff_stats.files.map((file) => (
                        <p key={file.path}>
                          <code>{file.path}</code>
                          <span>+{file.added} -{file.deleted}</span>
                        </p>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
              <form className="builder-follow-up" onSubmit={continueBuild}>
                <textarea
                  value={followUp}
                  onChange={(event) => setFollowUp(event.target.value)}
                  placeholder={activeStates.has(selectedRun.status) ? "Vector is working..." : "Ask Vector to change anything..."}
                  rows={2}
                  disabled={activeStates.has(selectedRun.status)}
                />
                <div>
                  <span>
                    <MessageSquare size={14} /> {selectedRun.model.split("/").at(-1)}
                  </span>
                  <button
                    type="submit"
                    aria-label="Send follow-up"
                    disabled={!!busy || activeStates.has(selectedRun.status) || !followUp.trim()}
                  >
                    {busy === "continue" ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={16} />}
                  </button>
                </div>
              </form>
            </section>
            <section className="builder-preview">
              <header>
                <div>
                  <Globe2 size={15} />
                  <span>{selectedRun.preview_url || "Live preview"}</span>
                </div>
                <div>
                  <button type="button" title="Refresh preview" onClick={() => void launchPreview(selectedRun)}>
                    <RefreshCw size={14} />
                  </button>
                  {selectedRun.preview_url && (
                    <a href={selectedRun.preview_url} target="_blank" rel="noreferrer" title="Open in a new tab">
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </header>
              <div className="builder-preview-viewport">
                {selectedRun.preview_url ? (
                  <iframe
                    key={selectedRun.preview_url}
                    src={selectedRun.preview_url}
                    title={selectedProject?.name || "Vector app preview"}
                    allow="clipboard-read; clipboard-write"
                  />
                ) : (
                  <div>
                    {activeStates.has(selectedRun.status) ? (
                      <LoaderCircle className="spin" size={24} />
                    ) : (
                      <Globe2 size={24} />
                    )}
                    <strong>
                      {activeStates.has(selectedRun.status)
                        ? "Vector is preparing your app"
                        : selectedRun.preview_status === "failed"
                          ? "The preview needs attention"
                          : "Preview this build"}
                    </strong>
                    <span>
                      {activeStates.has(selectedRun.status)
                        ? "The live app will appear here when the build is ready."
                        : "Start the generated app inside its isolated workspace."}
                    </span>
                    {!activeStates.has(selectedRun.status) && (
                      <button type="button" onClick={() => void launchPreview(selectedRun)} disabled={!!busy}>
                        {busy === "preview" ? <LoaderCircle className="spin" size={15} /> : <Globe2 size={15} />}
                        Open preview
                      </button>
                    )}
                  </div>
                )}
              </div>
              <footer>
                <span>
                  <Clock3 size={13} /> {formatDuration(selectedRun.started_at, selectedRun.completed_at)}
                </span>
                <span>{selectedRun.cost_usd ? "$" + selectedRun.cost_usd.toFixed(4) : "BYOK"}</span>
              </footer>
            </section>
          </div>
        </main>
      )}
      {message && (
        <div className="builder-toast">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage("")}>
            ×
          </button>
        </div>
      )}
    </div>
  )
}
