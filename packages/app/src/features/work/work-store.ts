export type WorkProject = {
  id: string
  name: string
  description: string
  repositoryPath?: string
  workspacePath: string
  createdAt: string
  updatedAt: string
}

export type WorkTaskStatus = "draft" | "active" | "review" | "done"

export type WorkTask = {
  id: string
  projectId: string
  title: string
  objective: string
  draftId?: string
  sessionId?: string
  status: WorkTaskStatus
  createdAt: string
  updatedAt: string
}

type WorkState = {
  version: 1
  projects: WorkProject[]
  tasks: WorkTask[]
}

const STORAGE_KEY = "vector.work.state.v1"
export const WORK_STATE_UPDATED_EVENT = "vector:work-state-updated"

const emptyState = (): WorkState => ({ version: 1, projects: [], tasks: [] })

export function createWorkID(prefix: "project" | "task") {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${id}`
}

export function readWorkState(): WorkState {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
  if (!raw) return emptyState()
  try {
    const value = JSON.parse(raw) as Partial<WorkState>
    return {
      version: 1,
      projects: Array.isArray(value.projects) ? value.projects.filter(validProject) : [],
      tasks: Array.isArray(value.tasks) ? value.tasks.filter(validTask) : [],
    }
  } catch {
    return emptyState()
  }
}

export function writeWorkState(state: WorkState) {
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state))
  globalThis.window?.dispatchEvent(new CustomEvent(WORK_STATE_UPDATED_EVENT))
}

export function saveWorkProject(project: WorkProject) {
  const state = readWorkState()
  const index = state.projects.findIndex((item) => item.id === project.id)
  if (index === -1) state.projects.unshift(project)
  else state.projects[index] = project
  writeWorkState(state)
  return project
}

export function saveWorkTask(task: WorkTask) {
  const state = readWorkState()
  const index = state.tasks.findIndex((item) => item.id === task.id)
  if (index === -1) state.tasks.unshift(task)
  else state.tasks[index] = task
  writeWorkState(state)
  return task
}

export function removeWorkProject(projectId: string) {
  const state = readWorkState()
  state.projects = state.projects.filter((project) => project.id !== projectId)
  state.tasks = state.tasks.filter((task) => task.projectId !== projectId)
  writeWorkState(state)
}

export function removeWorkTask(taskId: string) {
  const state = readWorkState()
  state.tasks = state.tasks.filter((task) => task.id !== taskId)
  writeWorkState(state)
}

export function bindWorkTaskSession(draftId: string, sessionId: string) {
  const state = readWorkState()
  const index = state.tasks.findIndex((task) => task.draftId === draftId)
  if (index === -1) return
  const task = state.tasks[index]
  state.tasks[index] = {
    ...task,
    draftId: undefined,
    sessionId,
    status: "active",
    updatedAt: new Date().toISOString(),
  }
  writeWorkState(state)
}

export function workTaskForSession(sessionId: string | undefined) {
  if (!sessionId) return undefined
  return readWorkState().tasks.find((task) => task.sessionId === sessionId)
}

export function workTaskForDraft(draftId: string | undefined) {
  if (!draftId) return undefined
  return readWorkState().tasks.find((task) => task.draftId === draftId)
}

export function workProjectForTask(task: WorkTask | undefined) {
  if (!task) return undefined
  return readWorkState().projects.find((project) => project.id === task.projectId)
}

function validProject(value: unknown): value is WorkProject {
  if (!value || typeof value !== "object") return false
  const project = value as Partial<WorkProject>
  return typeof project.id === "string" && typeof project.name === "string" && typeof project.workspacePath === "string"
}

function validTask(value: unknown): value is WorkTask {
  if (!value || typeof value !== "object") return false
  const task = value as Partial<WorkTask>
  return typeof task.id === "string" && typeof task.projectId === "string" && typeof task.title === "string"
}
