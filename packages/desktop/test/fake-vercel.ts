// A local stand-in for the Vercel REST API (https://vercel.com/docs/rest-api),
// answering with the documented request and response shapes for the endpoints
// Vector uses. It keeps state, so a test can create, promote or delete
// something and then read it back. Point Vector at it with
// VECTOR_VERCEL_API_URL.

export type FakeProject = {
  id: string
  name: string
  accountId: string
  teamId?: string
  framework?: string | null
  rootDirectory?: string | null
  buildCommand?: string | null
  outputDirectory?: string | null
  installCommand?: string | null
  nodeVersion: string
  productionId?: string
  ssoProtection?: { deploymentType: string } | null
  passwordProtection?: object | null
  protectionBypass: Record<string, { createdAt: number; createdBy: string; scope: string }>
  link?: { type: string; org?: string; repo: string }
}

export type FakeDeployment = {
  uid: string
  url: string
  name: string
  projectId: string
  readyState: string
  /** STAGED: a production build that has not served production; PROMOTED: one that has. */
  readySubstate?: "STAGED" | "PROMOTED"
  /** false when the create request asked Vercel not to move production's domains to it. */
  autoAssignCustomDomains?: boolean
  target: "production" | null
  created: number
  source?: string
  meta?: Record<string, string>
  alias: string[]
  errorMessage?: string
  events: { type: string; created: number; payload: { text: string } }[]
  runtime: object[]
}

export type FakeEnv = {
  id: string
  key: string
  value: string
  type: string
  target: string[]
  gitBranch?: string
  comment?: string
  createdAt: number
  updatedAt: number
}

export type FakeDomain = {
  name: string
  apexName: string
  projectId: string
  verified: boolean
  verification?: { type: string; domain: string; value: string; reason: string }[]
  createdAt: number
}

export type FakeRequest = { method: string; path: string; query: Record<string, string>; body: unknown }

export function fakeVercel(options: { token?: string } = {}) {
  const token = options.token ?? "vercel-fixture-token"
  const state = {
    rejectToken: false,
    user: { id: "user_1", username: "ada", name: "Ada Lovelace", email: "ada@example.invalid" },
    teams: [
      { id: "team_1", slug: "acme", name: "Acme", createdAt: 3_000 },
      { id: "team_2", slug: "globex", name: "Globex", createdAt: 2_000 },
      { id: "team_3", slug: "initech", name: "Initech", createdAt: 1_000 },
    ],
    projects: [] as FakeProject[],
    deployments: [] as FakeDeployment[],
    env: [] as (FakeEnv & { projectId: string })[],
    domains: [] as FakeDomain[],
    domainConfig: new Map<string, object>(),
    verifiable: new Set<string>(),
    requests: [] as FakeRequest[],
    /** Integration installations (configurationId to the team it was installed on). */
    configurations: new Map<string, string | undefined>(),
    pageSize: undefined as number | undefined,
  }
  let sequence = 0
  const nextId = (prefix: string) => `${prefix}_${++sequence}`

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const query = Object.fromEntries(url.searchParams)
      const text = await request.text()
      const body: unknown = text ? JSON.parse(text) : undefined
      state.requests.push({ method: request.method, path: url.pathname, query, body })
      if (request.headers.get("authorization") !== `Bearer ${token}` || state.rejectToken) {
        return Response.json(
          { error: { code: "forbidden", message: "Not authorized", invalidToken: true } },
          { status: 403 },
        )
      }
      return route(request.method, url.pathname, query, body)
    },
  })

  function route(method: string, path: string, query: Record<string, string>, body: unknown): Response {
    const parts = path.split("/").filter(Boolean)
    const scopeOf = () => query.teamId
    const projectOf = (idOrName: string) =>
      state.projects.find(
        (project) => (project.id === idOrName || project.name === idOrName) && project.teamId === scopeOf(),
      )
    const notFound = (message = "Not found") =>
      Response.json({ error: { code: "not_found", message } }, { status: 404 })

    // https://vercel.com/docs/rest-api/user/get-the-user
    if (method === "GET" && path === "/v2/user") return Response.json({ user: state.user })
    // https://vercel.com/docs/rest-api/reference/endpoints/integrations/delete-an-integration-configuration
    if (method === "DELETE" && parts[0] === "v1" && parts[1] === "integrations" && parts[2] === "configuration") {
      if (!state.configurations.has(parts[3]) || state.configurations.get(parts[3]) !== scopeOf()) return notFound()
      state.configurations.delete(parts[3])
      // Removing the installation revokes its token.
      state.rejectToken = true
      return new Response(null, { status: 204 })
    }
    // https://vercel.com/docs/rest-api/teams/list-all-teams (pagination by `until`)
    if (method === "GET" && path === "/v2/teams") {
      return Response.json(paged("teams", state.teams, (team) => team.createdAt, query))
    }
    if (method === "GET" && parts[0] === "v2" && parts[1] === "teams" && parts[2]) {
      const team = state.teams.find((item) => item.id === parts[2])
      return team ? Response.json(team) : notFound()
    }
    // https://vercel.com/docs/rest-api/projects/retrieve-a-list-of-projects (continuation in `from`)
    if (method === "GET" && path === "/v10/projects") {
      const visible = state.projects.filter((project) => project.teamId === scopeOf())
      const limit = Number(query.limit ?? 20)
      const start = query.from ? Number(query.from.replace("cursor-", "")) : 0
      const page = visible.slice(start, start + Math.min(limit, state.pageSize ?? limit))
      const next = start + page.length < visible.length ? `cursor-${start + page.length}` : null
      return Response.json({ projects: page.map(projectBody), pagination: { count: page.length, next } })
    }
    // https://vercel.com/docs/rest-api/projects/create-a-new-project
    if (method === "POST" && path === "/v11/projects") {
      const input = body as { name: string; framework?: string; rootDirectory?: string }
      if (state.projects.some((project) => project.name === input.name && project.teamId === scopeOf())) {
        return Response.json({ error: { code: "conflict", message: "Project already exists" } }, { status: 409 })
      }
      const project: FakeProject = {
        id: nextId("prj"),
        name: input.name,
        accountId: scopeOf() ?? state.user.id,
        teamId: scopeOf(),
        framework: input.framework ?? null,
        rootDirectory: input.rootDirectory ?? null,
        nodeVersion: "22.x",
        ssoProtection: { deploymentType: "preview" },
        protectionBypass: {},
      }
      state.projects.push(project)
      return Response.json(projectBody(project))
    }
    if (parts[1] === "projects" && parts[2]) {
      const project = projectOf(decodeURIComponent(parts[2]))
      if (!project) return notFound("Project not found")
      const rest = parts.slice(3)
      // https://vercel.com/docs/rest-api/projects/find-a-project-by-id-or-name
      if (method === "GET" && rest.length === 0) return Response.json(projectBody(project))
      // https://vercel.com/docs/rest-api/projects/update-an-existing-project
      if (method === "PATCH" && rest.length === 0) {
        Object.assign(project, body)
        return Response.json(projectBody(project))
      }
      // https://vercel.com/docs/rest-api/projects/update-protection-bypass-for-automation
      if (method === "PATCH" && rest[0] === "protection-bypass") {
        project.protectionBypass[`secret${String(++sequence).padStart(26, "0")}abcdef`] = {
          createdAt: Date.now(),
          createdBy: state.user.id,
          scope: "automation-bypass",
        }
        return Response.json({ protectionBypass: project.protectionBypass })
      }
      // https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment
      if (method === "POST" && rest[0] === "promote") {
        const deployment = state.deployments.find((item) => item.uid === rest[1] && item.projectId === project.id)
        if (!deployment) return notFound()
        project.productionId = deployment.uid
        deployment.alias = productionAliases(project)
        deployment.readySubstate = "PROMOTED"
        return new Response(null, { status: 201 })
      }
      // https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-previous-production-deployment-by-id
      if (method === "POST" && rest[0] === "rollback") {
        const deployment = state.deployments.find((item) => item.uid === rest[1] && item.projectId === project.id)
        if (!deployment || deployment.target !== "production") {
          return Response.json({ error: { code: "invalid", message: "Not a production deployment" } }, { status: 422 })
        }
        project.productionId = deployment.uid
        deployment.readySubstate = "PROMOTED"
        return new Response(null, { status: 201 })
      }
      // https://vercel.com/docs/rest-api/logs/get-logs-for-a-deployment: stream+json that stays open
      if (method === "GET" && rest[0] === "deployments" && rest[2] === "runtime-logs") {
        const deployment = state.deployments.find((item) => item.uid === rest[1])
        if (!deployment) return notFound()
        const lines = deployment.runtime.map((line) => `${JSON.stringify(line)}\n`)
        const stream = new ReadableStream({
          start(controller) {
            for (const line of lines) controller.enqueue(new TextEncoder().encode(line))
          },
        })
        return new Response(stream, { headers: { "content-type": "application/stream+json" } })
      }
      // https://vercel.com/docs/rest-api/projects/retrieve-the-environment-variables-of-a-project-by-id-or-name
      if (method === "GET" && rest[0] === "env" && rest.length === 1) {
        const decrypt = query.decrypt === "true"
        return Response.json({
          envs: state.env
            .filter((entry) => entry.projectId === project.id)
            .map((entry) => ({
              id: entry.id,
              key: entry.key,
              type: entry.type,
              target: entry.target,
              gitBranch: entry.gitBranch,
              comment: entry.comment,
              createdAt: entry.createdAt,
              updatedAt: entry.updatedAt,
              decrypted: decrypt && entry.type !== "sensitive",
              value: decrypt && entry.type !== "sensitive" ? entry.value : `encrypted:${entry.id}`,
            })),
        })
      }
      // https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables
      if (method === "POST" && rest[0] === "env") {
        const entries = (Array.isArray(body) ? body : [body]) as FakeEnv[]
        const created: object[] = []
        const failed: object[] = []
        for (const entry of entries) {
          const clash = state.env.some(
            (item) =>
              item.projectId === project.id &&
              item.key === entry.key &&
              item.gitBranch === entry.gitBranch &&
              item.target.some((target) => entry.target.includes(target)),
          )
          if (clash) {
            failed.push({
              error: {
                code: "ENV_CONFLICT",
                message: `A variable with the name ${entry.key} already exists`,
                value: entry.value,
              },
            })
            continue
          }
          const record = {
            ...entry,
            id: nextId("env"),
            projectId: project.id,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          state.env.push(record)
          created.push(record)
        }
        return Response.json({ created: created.length === 1 ? created[0] : created, failed }, { status: 201 })
      }
      // https://vercel.com/docs/rest-api/projects/edit-an-environment-variable and remove-an-environment-variable
      if (rest[0] === "env" && rest[1]) {
        const entry = state.env.find((item) => item.id === rest[1] && item.projectId === project.id)
        if (!entry) return notFound()
        if (method === "PATCH") {
          Object.assign(entry, body, { updatedAt: entry.updatedAt + 1 })
          return Response.json(entry)
        }
        if (method === "DELETE") {
          state.env = state.env.filter((item) => item !== entry)
          return Response.json(entry)
        }
      }
      // https://vercel.com/docs/rest-api/projects/retrieve-project-domains-by-project-by-id-or-name
      if (method === "GET" && rest[0] === "domains" && rest.length === 1) {
        return Response.json(
          paged(
            "domains",
            state.domains.filter((domain) => domain.projectId === project.id),
            (domain) => domain.createdAt,
            query,
          ),
        )
      }
      // https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project
      if (method === "POST" && rest[0] === "domains" && rest.length === 1) {
        const name = (body as { name: string }).name
        const apexName = name.split(".").slice(-2).join(".")
        const domain: FakeDomain = {
          name,
          apexName,
          projectId: project.id,
          verified: state.verifiable.has(name),
          verification: state.verifiable.has(name)
            ? undefined
            : [
                {
                  type: "TXT",
                  domain: `_vercel.${apexName}`,
                  value: `vc-domain-verify=${name},fixture`,
                  reason: "pending_domain_verification",
                },
              ],
          createdAt: Date.now() + state.domains.length,
        }
        state.domains.push(domain)
        return Response.json(domain)
      }
      if (rest[0] === "domains" && rest[1]) {
        const domain = state.domains.find((item) => item.name === rest[1] && item.projectId === project.id)
        if (!domain) return notFound("Domain not found")
        if (method === "GET") return Response.json(domain)
        if (method === "DELETE") {
          state.domains = state.domains.filter((item) => item !== domain)
          return Response.json({})
        }
        // https://vercel.com/docs/rest-api/projects/verify-project-domain
        if (method === "POST" && rest[2] === "verify") {
          if (!state.verifiable.has(domain.name)) {
            return Response.json(
              { error: { code: "missing_txt_record", message: "TXT record not found" } },
              { status: 400 },
            )
          }
          domain.verified = true
          domain.verification = undefined
          return Response.json(domain)
        }
      }
    }
    // https://vercel.com/docs/rest-api/deployments/list-deployments (pagination by `until`)
    if (method === "GET" && path === "/v6/deployments") {
      const visible = state.deployments.filter(
        (deployment) =>
          deployment.projectId === query.projectId &&
          (!query.target ||
            (query.target === "production" ? deployment.target === "production" : deployment.target === null)) &&
          (!query.state || deployment.readyState === query.state),
      )
      return Response.json(paged("deployments", visible, (deployment) => deployment.created, query, deploymentBody))
    }
    // https://vercel.com/docs/rest-api/deployments/get-a-deployment-by-id-or-url
    if (method === "GET" && parts[0] === "v13" && parts[1] === "deployments" && parts[2]) {
      const deployment = findDeployment(decodeURIComponent(parts[2]))
      return deployment ? Response.json(deploymentBody(deployment)) : notFound("Deployment not found")
    }
    // https://vercel.com/docs/rest-api/deployments/create-a-new-deployment (a redeploy)
    if (method === "POST" && path === "/v13/deployments") {
      const input = body as {
        name: string
        project: string
        deploymentId: string
        target?: string
        autoAssignCustomDomains?: boolean
      }
      const from = findDeployment(input.deploymentId)
      if (!from) return notFound()
      const deployment = addDeployment({
        projectId: from.projectId,
        name: input.name,
        target: input.target === "production" ? "production" : null,
        readyState: "QUEUED",
        source: "redeploy",
        autoAssignCustomDomains: input.autoAssignCustomDomains,
      })
      return Response.json(deploymentBody(deployment))
    }
    // https://vercel.com/docs/rest-api/deployments/cancel-a-deployment
    if (method === "PATCH" && parts[1] === "deployments" && parts[3] === "cancel") {
      const deployment = findDeployment(parts[2])
      if (!deployment) return notFound()
      deployment.readyState = "CANCELED"
      return Response.json(deploymentBody(deployment))
    }
    // https://vercel.com/docs/rest-api/deployments/get-deployment-events
    if (method === "GET" && parts[1] === "deployments" && parts[3] === "events") {
      const deployment = findDeployment(decodeURIComponent(parts[2]))
      if (!deployment) return notFound()
      return Response.json([...deployment.events].reverse().slice(0, Number(query.limit ?? 100)))
    }
    // https://vercel.com/docs/rest-api/aliases/assign-an-alias
    if (method === "POST" && parts[1] === "deployments" && parts[3] === "aliases") {
      const deployment = findDeployment(parts[2])
      if (!deployment) return notFound()
      const alias = (body as { alias: string }).alias
      deployment.alias.push(alias)
      return Response.json({ uid: nextId("alias"), alias, created: new Date().toISOString() })
    }
    // https://vercel.com/docs/rest-api/domains/get-a-domain-s-configuration
    if (method === "GET" && parts[0] === "v6" && parts[1] === "domains" && parts[3] === "config") {
      return Response.json(
        state.domainConfig.get(parts[2]) ?? {
          configuredBy: null,
          acceptedChallenges: [],
          misconfigured: true,
          recommendedIPv4: [{ rank: 1, value: ["76.76.21.21"] }],
          recommendedCNAME: [{ rank: 1, value: "cname.vercel-dns-fixture.com." }],
        },
      )
    }
    return notFound(`No fake route for ${method} ${path}`)
  }

  function findDeployment(idOrUrl: string) {
    return state.deployments.find((item) => item.uid === idOrUrl || item.url === idOrUrl)
  }

  function productionAliases(project: FakeProject) {
    return [
      `${project.name}.vercel.app`,
      ...state.domains
        .filter((domain) => domain.projectId === project.id && domain.verified)
        .map((domain) => domain.name),
    ]
  }

  function projectBody(project: FakeProject) {
    const production = state.deployments.find((item) => item.uid === project.productionId)
    return {
      id: project.id,
      name: project.name,
      accountId: project.accountId,
      framework: project.framework ?? null,
      rootDirectory: project.rootDirectory ?? null,
      buildCommand: project.buildCommand ?? null,
      outputDirectory: project.outputDirectory ?? null,
      installCommand: project.installCommand ?? null,
      nodeVersion: project.nodeVersion,
      ssoProtection: project.ssoProtection ?? null,
      passwordProtection: project.passwordProtection ?? null,
      protectionBypass: project.protectionBypass,
      link: project.link,
      updatedAt: 1_700_000_000_000,
      targets: production
        ? { production: { id: production.uid, alias: productionAliases(project), url: production.url } }
        : {},
    }
  }

  function deploymentBody(deployment: FakeDeployment) {
    return {
      uid: deployment.uid,
      id: deployment.uid,
      url: deployment.url,
      name: deployment.name,
      projectId: deployment.projectId,
      readyState: deployment.readyState,
      readySubstate: deployment.readyState === "READY" ? deployment.readySubstate : undefined,
      state: deployment.readyState,
      target: deployment.target,
      created: deployment.created,
      createdAt: deployment.created,
      source: deployment.source,
      meta: deployment.meta ?? {},
      alias: deployment.alias,
      errorMessage: deployment.errorMessage,
      inspectorUrl: `https://vercel.com/fixture/${deployment.name}/${deployment.uid}`,
      creator: { uid: state.user.id, username: state.user.username },
    }
  }

  function paged<T>(
    key: string,
    items: T[],
    time: (item: T) => number,
    query: Record<string, string>,
    shape: (item: T) => unknown = (item) => item,
  ) {
    const ordered = [...items].sort((left, right) => time(right) - time(left))
    const until = query.until ? Number(query.until) : Number.POSITIVE_INFINITY
    const remaining = ordered.filter((item) => time(item) < until)
    const limit = Math.min(Number(query.limit ?? 20), state.pageSize ?? Number.POSITIVE_INFINITY)
    const page = remaining.slice(0, limit)
    const next = remaining.length > page.length && page.length ? time(page[page.length - 1]) : null
    return { [key]: page.map(shape), pagination: { count: page.length, next, prev: null } }
  }

  function addDeployment(input: Partial<FakeDeployment> & { projectId: string }) {
    const project = state.projects.find((item) => item.id === input.projectId)
    const uid = input.uid ?? nextId("dpl")
    const deployment: FakeDeployment = {
      uid,
      url: input.url ?? `${project?.name ?? "app"}-${uid.replace("_", "")}.vercel.app`,
      name: input.name ?? project?.name ?? "app",
      projectId: input.projectId,
      readyState: input.readyState ?? "READY",
      readySubstate: input.readySubstate,
      autoAssignCustomDomains: input.autoAssignCustomDomains,
      target: input.target ?? null,
      created: input.created ?? 1_700_000_000_000 + sequence * 1_000,
      source: input.source ?? "cli",
      meta: input.meta,
      alias: input.alias ?? [],
      errorMessage: input.errorMessage,
      events: input.events ?? [{ type: "stdout", created: 1, payload: { text: "Build completed" } }],
      runtime: input.runtime ?? [],
    }
    state.deployments.push(deployment)
    return deployment
  }

  function addProject(input: Partial<FakeProject> & { name: string }) {
    const project: FakeProject = {
      id: input.id ?? nextId("prj"),
      accountId: input.teamId ?? state.user.id,
      nodeVersion: "22.x",
      protectionBypass: {},
      ssoProtection: null,
      ...input,
    }
    state.projects.push(project)
    return project
  }

  return {
    state,
    token,
    url: server.url.toString().replace(/\/$/, ""),
    addProject,
    addDeployment,
    addEnv(projectId: string, entry: Omit<FakeEnv, "id" | "createdAt" | "updatedAt">) {
      const record = { ...entry, id: nextId("env"), projectId, createdAt: 1, updatedAt: 1 }
      state.env.push(record)
      return record
    },
    requests: (method?: string) => state.requests.filter((item) => !method || item.method === method),
    stop: () => server.stop(true),
  }
}
