import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useDirectoryPicker } from "@/components/directory-picker"
import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { draftHref, useTabs } from "@/context/tabs"
import { sessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"
import { VectorAsciiField } from "@/components/vector-ascii-field"
import {
  createWorkID,
  readWorkState,
  removeWorkProject,
  removeWorkTask,
  saveWorkProject,
  saveWorkTask,
  WORK_STATE_UPDATED_EVENT,
  type WorkProject,
  type WorkTask,
} from "./work-store"

const pathName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path

export function WorkHome() {
  const navigate = useNavigate()
  const server = useServer()
  const global = useGlobal()
  const tabs = useTabs()
  const pickDirectory = useDirectoryPicker()
  const [state, setState] = createSignal(readWorkState())
  const [selectedProjectId, setSelectedProjectId] = createSignal(state().projects[0]?.id ?? "")
  const [creatingProject, setCreatingProject] = createSignal(false)
  const [creatingTask, setCreatingTask] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [projectName, setProjectName] = createSignal("")
  const [projectDescription, setProjectDescription] = createSignal("")
  const [repositoryPath, setRepositoryPath] = createSignal("")
  const [taskTitle, setTaskTitle] = createSignal("")
  const [taskObjective, setTaskObjective] = createSignal("")

  const reload = () => {
    const next = readWorkState()
    setState(next)
    if (!next.projects.some((project) => project.id === selectedProjectId())) {
      setSelectedProjectId(next.projects[0]?.id ?? "")
    }
  }
  onMount(() => window.addEventListener(WORK_STATE_UPDATED_EVENT, reload))
  onCleanup(() => window.removeEventListener(WORK_STATE_UPDATED_EVENT, reload))

  const selectedProject = createMemo(() => state().projects.find((project) => project.id === selectedProjectId()))
  const tasks = createMemo(() => state().tasks.filter((task) => task.projectId === selectedProjectId()))

  const chooseRepository = () => {
    const conn = server.current
    if (!conn) return
    pickDirectory({
      server: conn,
      title: "Attach a repository to this Work project",
      multiple: false,
      onSelect: (value) => {
        const path = Array.isArray(value) ? value[0] : value
        if (path) setRepositoryPath(path)
      },
    })
  }

  const createProject = async () => {
    const name = projectName().trim()
    if (!name) {
      showToast({ variant: "error", title: "Name this project", description: "A Work project needs a clear name." })
      return
    }
    setBusy(true)
    const id = createWorkID("project")
    let workspacePath = repositoryPath().trim()
    if (!workspacePath) {
      const api = window.api as (typeof window.api & {
        workProjects?: { ensureDirectory: (projectId: string, name: string) => Promise<string> }
      }) | undefined
      workspacePath = await api?.workProjects?.ensureDirectory(id, name).catch(() => "") ?? ""
    }
    if (!workspacePath) {
      setBusy(false)
      showToast({
        variant: "error",
        title: "Choose a local workspace",
        description: "The browser build cannot create managed project folders. Attach a repository or use Vector Desktop.",
      })
      return
    }
    const now = new Date().toISOString()
    const attachedRepository = Boolean(repositoryPath().trim())
    const project: WorkProject = {
      id,
      name,
      description: projectDescription().trim(),
      repositoryPath: repositoryPath().trim() || undefined,
      workspacePath,
      createdAt: now,
      updatedAt: now,
    }
    saveWorkProject(project)
    const conn = server.current
    if (conn) {
      const ctx = global.ensureServerCtx(conn)
      ctx.projects.open(workspacePath)
      ctx.projects.touch(workspacePath)
    }
    setSelectedProjectId(id)
    setProjectName("")
    setProjectDescription("")
    setRepositoryPath("")
    setCreatingProject(false)
    setBusy(false)
    showToast({ title: "Work project ready", description: attachedRepository ? "Repository attached." : "Managed local workspace created." })
  }

  const createTask = () => {
    const project = selectedProject()
    const title = taskTitle().trim()
    const objective = taskObjective().trim()
    const conn = server.current
    if (!project || !conn) return
    if (!title || !objective) {
      showToast({ variant: "error", title: "Describe the task", description: "Add a task name and the outcome you want." })
      return
    }
    const ctx = global.ensureServerCtx(conn)
    ctx.projects.open(project.workspacePath)
    ctx.projects.touch(project.workspacePath)
    const draftId = tabs.newDraft({ server: ServerConnection.key(conn), directory: project.workspacePath }, objective)
    const now = new Date().toISOString()
    saveWorkTask({
      id: createWorkID("task"),
      projectId: project.id,
      title,
      objective,
      draftId,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    })
    setTaskTitle("")
    setTaskObjective("")
    setCreatingTask(false)
  }

  const openTask = (task: WorkTask) => {
    if (task.sessionId) {
      navigate(sessionHref(server.key, task.sessionId))
      return
    }
    if (task.draftId && tabs.store.some((tab) => tab.type === "draft" && tab.draftID === task.draftId)) {
      navigate(draftHref(task.draftId))
      return
    }
    const project = state().projects.find((item) => item.id === task.projectId)
    if (!project) return
    const draftId = tabs.newDraft({ server: server.key, directory: project.workspacePath }, task.objective)
    saveWorkTask({ ...task, draftId, status: "draft", updatedAt: new Date().toISOString() })
  }

  return (
    <main data-vector-work-home class="relative min-h-0 flex-1 self-stretch overflow-hidden bg-[var(--vx-stage)] text-white">
      <VectorAsciiField />
      <div class="vector-suite-page__veil" aria-hidden="true" />
      <div class="vector-work-home__shell">
        <header class="vector-suite-header">
          <button type="button" class="vector-suite-header__back" onClick={() => navigate("/")}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.75 3.5-4.5 4.5 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
            All Vector
          </button>
          <div class="vector-suite-header__brand"><img src="/vector-logo.png" alt="" /><span>Vector Work</span></div>
        </header>

        <div class="vector-work-home__layout">
          <aside class="vector-work-projects">
            <div class="vector-work-projects__heading">
              <div><span>Workspace</span><h1>Projects</h1></div>
              <button type="button" title="New project" aria-label="New project" onClick={() => setCreatingProject(true)}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
              </button>
            </div>
            <div class="vector-work-projects__list">
              <For each={state().projects}>
                {(project) => (
                  <button type="button" classList={{ active: selectedProjectId() === project.id }} onClick={() => setSelectedProjectId(project.id)}>
                    <span class="vector-work-projects__avatar">{project.name.slice(0, 1).toUpperCase()}</span>
                    <span><strong>{project.name}</strong><small>{project.repositoryPath ? pathName(project.repositoryPath) : "Managed workspace"}</small></span>
                    <i />
                  </button>
                )}
              </For>
              <Show when={!state().projects.length}>
                <div class="vector-work-projects__empty">Create a project to group tasks, agent work and connected tools.</div>
              </Show>
            </div>
          </aside>

          <section class="vector-work-tasks">
            <Show
              when={selectedProject()}
              fallback={
                <div class="vector-work-empty">
                  <span class="vector-work-empty__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h6l1.5 2H20v10H4V7Z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" /></svg></span>
                  <h2>Start a Work project</h2>
                  <p>Keep tasks, agent sessions, browser activity and integrations together. A repository is optional.</p>
                  <button type="button" onClick={() => setCreatingProject(true)}>Create project</button>
                </div>
              }
            >
              {(project) => (
                <>
                  <div class="vector-work-tasks__header">
                    <div>
                      <span>Vector Work</span>
                      <h1>{project().name}</h1>
                      <p>{project().description || "Coordinate outcomes across agents, browser work and connected tools."}</p>
                    </div>
                    <div class="vector-work-tasks__actions">
                      <button type="button" onClick={() => setCreatingTask(true)}>New task</button>
                    </div>
                  </div>

                  <div class="vector-work-capabilities" aria-label="Available in every task">
                    <span>Agent + parallel workspaces</span><span>Controlled browser</span><span>Vel voice assistant</span><span>MCP + plugins</span>
                  </div>

                  <div class="vector-work-task-list">
                    <div class="vector-work-task-list__heading"><span>Tasks</span><small>{tasks().length}</small></div>
                    <For each={tasks()}>
                      {(task) => (
                        <article class="vector-work-task-row">
                          <button type="button" class="vector-work-task-row__main" onClick={() => openTask(task)}>
                            <span class={`vector-work-task-row__status is-${task.status}`} />
                            <span><strong>{task.title}</strong><small>{task.objective}</small></span>
                            <em>{task.status === "draft" ? "Ready" : task.status}</em>
                            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.75 10.25 8 6 12.25" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                          </button>
                          <button type="button" class="vector-work-task-row__remove" title="Remove task" aria-label={`Remove ${task.title}`} onClick={() => removeWorkTask(task.id)}>
                            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" /></svg>
                          </button>
                        </article>
                      )}
                    </For>
                    <Show when={!tasks().length}>
                      <button type="button" class="vector-work-task-list__empty" onClick={() => setCreatingTask(true)}>
                        <strong>No tasks yet</strong><span>Describe an outcome and open a complete Vector agent workspace.</span>
                      </button>
                    </Show>
                  </div>

                  <div class="vector-work-project-footer">
                    <span>{project().repositoryPath ? `Repository · ${project().repositoryPath}` : `Local workspace · ${project().workspacePath}`}</span>
                    <button type="button" onClick={() => removeWorkProject(project().id)}>Remove project</button>
                  </div>
                </>
              )}
            </Show>
          </section>
        </div>
      </div>

      <Show when={creatingProject()}>
        <div class="vector-suite-modal" role="dialog" aria-modal="true" aria-label="Create Work project">
          <form class="vector-suite-modal__panel" onSubmit={(event) => { event.preventDefault(); void createProject() }}>
            <header><div><span>Vector Work</span><h2>Create a project</h2></div><button type="button" aria-label="Close" onClick={() => setCreatingProject(false)}>×</button></header>
            <label><span>Project name</span><input value={projectName()} onInput={(event) => setProjectName(event.currentTarget.value)} placeholder="Product launch" autofocus /></label>
            <label><span>What is this project for?</span><textarea value={projectDescription()} onInput={(event) => setProjectDescription(event.currentTarget.value)} placeholder="Ship the next version of our customer portal." rows={3} /></label>
            <div class="vector-suite-modal__repository">
              <div><strong>Repository</strong><span>Optional. Attach existing code now or start in a managed local workspace.</span></div>
              <button type="button" onClick={chooseRepository}>{repositoryPath() ? "Change" : "Attach"}</button>
              <Show when={repositoryPath()}><small>{repositoryPath()}</small></Show>
            </div>
            <footer><button type="button" class="secondary" onClick={() => setCreatingProject(false)}>Cancel</button><button type="submit" disabled={busy()}>{busy() ? "Creating…" : "Create project"}</button></footer>
          </form>
        </div>
      </Show>

      <Show when={creatingTask() && selectedProject()}>
        <div class="vector-suite-modal" role="dialog" aria-modal="true" aria-label="Create Work task">
          <form class="vector-suite-modal__panel" onSubmit={(event) => { event.preventDefault(); createTask() }}>
            <header><div><span>{selectedProject()!.name}</span><h2>Start a task</h2></div><button type="button" aria-label="Close" onClick={() => setCreatingTask(false)}>×</button></header>
            <label><span>Task name</span><input value={taskTitle()} onInput={(event) => setTaskTitle(event.currentTarget.value)} placeholder="Prepare launch analytics" autofocus /></label>
            <label><span>Outcome</span><textarea value={taskObjective()} onInput={(event) => setTaskObjective(event.currentTarget.value)} placeholder="Set up the analytics events, test them in the browser, and summarize the changes." rows={5} /></label>
            <p class="vector-suite-modal__note">This opens a normal Vector agent session. Parallel agents, browser control, MCP, plugins, terminal and review remain available.</p>
            <footer><button type="button" class="secondary" onClick={() => setCreatingTask(false)}>Cancel</button><button type="submit">Open task</button></footer>
          </form>
        </div>
      </Show>
    </main>
  )
}
