import { useLocation, useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLayout } from "@/context/layout"
import { VectorAsciiField } from "@/components/vector-ascii-field"
import { CloudConsole, type CloudSection } from "./cloud-console"

const CLOUD_PROJECT_KEY = "vector.cloud.selected-project.v2"

type CloudProject = {
  id: string
  name: string
  path: string
  source: "Repository"
}

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path

export function CloudHome() {
  const navigate = useNavigate()
  const location = useLocation()
  const layout = useLayout()
  const requestedProject = () => new URLSearchParams(location.search).get("project") ?? ""
  const requestedSection = () => new URLSearchParams(location.search).get("section") as CloudSection | null
  const [selectedPath, setSelectedPath] = createSignal(
    requestedProject() || globalThis.localStorage?.getItem(CLOUD_PROJECT_KEY) || "",
  )

  const projects = createMemo<CloudProject[]>(() => {
    const records = new Map<string, CloudProject>()
    layout.projects.list().forEach((project) => {
      if (!project.worktree) return
      records.set(project.worktree, {
        id: project.id || project.worktree,
        name: basename(project.worktree),
        path: project.worktree,
        source: "Repository",
      })
    })
    return [...records.values()].sort((left, right) => left.name.localeCompare(right.name))
  })
  const selectedProject = createMemo(() => projects().find((project) => project.path === selectedPath()))

  const selectProject = (path: string) => {
    setSelectedPath(path)
    globalThis.localStorage?.setItem(CLOUD_PROJECT_KEY, path)
  }

  return (
    <main
      data-vector-cloud-home
      class="relative min-h-0 flex-1 self-stretch overflow-hidden bg-[var(--vx-stage)] text-white"
    >
      <Show
        when={selectedProject()}
        fallback={
          <>
            <VectorAsciiField />
            <div class="vector-suite-page__veil" aria-hidden="true" />
            <div class="vector-cloud-home__shell">
              <header class="vector-suite-header">
                <button type="button" class="vector-suite-header__back" onClick={() => navigate("/")}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="m9.75 3.5-4.5 4.5 4.5 4.5"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                  Home
                </button>
                <div class="vector-suite-header__brand">
                  <img src="/vector-logo.png" alt="" />
                  <span>Cloud Services</span>
                </div>
              </header>

              <section class="vector-cloud-home__intro">
                <span>Deploy and operate</span>
                <h1>Choose a repository for Cloud Services.</h1>
                <p>
                  Select any repository, then manage deployments, domains, environment variables, databases, and runtime
                  health without leaving Vector.
                </p>
              </section>

              <section class="vector-cloud-projects" aria-label="Repositories available to Cloud Services">
                <div class="vector-cloud-projects__heading">
                  <span>Repositories</span>
                  <small>{projects().length}</small>
                </div>
                <For each={projects()}>
                  {(project) => (
                    <button type="button" onClick={() => selectProject(project.path)}>
                      <span class="vector-cloud-projects__icon">
                        <svg viewBox="0 0 20 20" aria-hidden="true">
                          <path
                            d="M4 6h5l1.4 1.7H16v7.8H4V6Z"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.2"
                            stroke-linejoin="round"
                          />
                        </svg>
                      </span>
                      <span>
                        <strong>{project.name}</strong>
                        <small>{project.path}</small>
                      </span>
                      <em>{project.source}</em>
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path
                          d="M6 3.75 10.25 8 6 12.25"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </For>
                <Show when={!projects().length}>
                  <div class="vector-cloud-projects__empty">
                    <strong>No repositories yet</strong>
                    <span>Open a repository from Vector Home first.</span>
                  </div>
                </Show>
              </section>
            </div>
          </>
        }
      >
        <CloudConsole
          embedded
          projectPath={selectedProject()!.path}
          onClose={() => {
            setSelectedPath("")
            globalThis.localStorage?.removeItem(CLOUD_PROJECT_KEY)
          }}
          onRepair={(context) => {
            void navigator.clipboard?.writeText(context)
          }}
          initialSection={requestedSection() ?? undefined}
        />
      </Show>
    </main>
  )
}
