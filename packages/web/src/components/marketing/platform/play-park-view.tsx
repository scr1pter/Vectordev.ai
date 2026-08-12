/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import type { Session } from "@supabase/supabase-js"
import {
  BarChart3,
  Bot,
  BookOpen,
  Braces,
  CheckCircle2,
  Clock3,
  Code2,
  Copy,
  Folder,
  Gauge,
  History,
  KeyRound,
  LayoutDashboard,
  PanelLeft,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react"
import { apiFetch, type PlatformConfig } from "./platform-client"

type ApiResult = {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  encoding: "text" | "base64"
  bytes: number
  durationMs: number
  url: string
  assertions?: TestResult[]
  evidence?: { id: string; createdAt: string }
}

function UsageCard(props: { label: string; value: number | string; limit?: number }) {
  const numeric = typeof props.value === "number" ? props.value : 0
  const percent = props.limit ? Math.min(100, Math.round((numeric / props.limit) * 100)) : 0
  return (
    <article className="play-usage-card">
      <span>{props.label}</span>
      <strong>{typeof props.value === "number" ? props.value.toLocaleString() : props.value}</strong>
      {props.limit ? (
        <>
          <div>
            <i style={{ width: `${percent}%` }} />
          </div>
          <small>
            {props.limit.toLocaleString()} included · {percent}% used
          </small>
        </>
      ) : (
        <small>Last 30 days</small>
      )}
    </article>
  )
}
type AssertionSummary = { total: number; passed: number; failed: number; invalid: number }
type HistoryItem = {
  id: string
  method: string
  url: string
  status?: number | null
  duration_ms?: number | null
  response_bytes?: number | null
  response_summary?: { assertions?: AssertionSummary }
  created_at: string
}
type RequestDraft = {
  name: string
  method: string
  url: string
  headers: Record<string, string>
  body: string
  tests: string
}
type Collection = {
  id: string
  name: string
  description?: string
  requests: RequestDraft[]
  updated_at: string
}
type Environment = {
  id: string
  name: string
  values?: Record<string, string>
  updated_at: string
}
type TestResult = { expression: string; pass: boolean; valid: boolean; detail: string }
type ApiKeyRecord = {
  id: string
  name: string
  secret_prefix: string
  last_four: string
  scopes: string[]
  daily_unit_limit: number
  expires_at?: string | null
  last_used_at?: string | null
  created_at: string
  revoked_at?: string | null
}
type Usage = {
  periodDays: number
  apiRequests: number
  cloudRuns: number
  activeRuns: number
  completedRuns: number
  cloudTokens: number
  cloudCostUsd: number
  activeApiKeys: number
  connectedTools: number
  cloudLaunchesUsed: number
  cloudTurnsUsed: number
  apiExecutionsToday: number
  limits: {
    activeCloudAgents: number
    cloudAgentLaunches30Days: number
    cloudAgentTurns30Days: number
    apiExecutionsPerDay: number
  }
}
type OpenApiDocument = {
  info?: { title?: string; version?: string; description?: string }
  paths?: Record<string, Record<string, { summary?: string; description?: string }>>
}
type ItemsPayload<T> = { items: T[] }
type KeysPayload = { keys: ApiKeyRecord[] }
type SecretPayload = { secret: string }

const sideTabs = ["collections", "history", "environments"] as const
const requestTabs = ["headers", "body", "tests", "code"] as const
const responseTabs = ["body", "headers", "tests"] as const
const platformSections = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "workbench", label: "Request workbench", icon: Play },
  { id: "keys", label: "API keys", icon: KeyRound },
  { id: "schema", label: "API reference", icon: BookOpen },
  { id: "usage", label: "Usage", icon: BarChart3 },
] as const

const emptyRequest: RequestDraft = {
  name: "Untitled request",
  method: "GET",
  url: "https://api.github.com/zen",
  headers: { Accept: "application/json" },
  body: "",
  tests: "status == 200\nresponse_time < 3000",
}

const secretHeader = /^(authorization|cookie|set-cookie|x-api-key|x-vector-api-key|proxy-authorization)$/i

function safeCollectionHeaders(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !secretHeader.test(name)))
}

function vectorApiCollection(origin: string): Collection {
  const base = /localhost|127\.0\.0\.1/.test(origin) ? "https://vectordev.ai" : origin
  const auth = { "X-Vector-API-Key": "{{vectorApiKey}}", "Content-Type": "application/json" }
  return {
    id: "vector-api-built-in",
    name: "Vector API",
    description: "Built-in examples for isolated agents and verified execution.",
    updated_at: new Date(0).toISOString(),
    requests: [
      {
        name: "List cloud agents",
        method: "GET",
        url: `${base}/api/v1/agents`,
        headers: auth,
        body: "",
        tests: "status == 200\njson:runs exists",
      },
      {
        name: "Launch cloud agent",
        method: "POST",
        url: `${base}/api/v1/agents`,
        headers: auth,
        body: '{\n  "name": "Review authentication",\n  "prompt": "Inspect authentication, fix concrete defects, and run the relevant checks.",\n  "repositoryUrl": "https://github.com/owner/repository.git",\n  "model": "provider/model"\n}',
        tests: "status == 201\njson:run.id exists",
      },
      {
        name: "Continue cloud agent",
        method: "POST",
        url: `${base}/api/v1/agent`,
        headers: auth,
        body: '{\n  "id": "agent-run-id",\n  "action": "continue",\n  "prompt": "Run the test suite and fix any failures you introduced."\n}',
        tests: "status == 202",
      },
      {
        name: "Verified API request",
        method: "POST",
        url: `${base}/api/v1/execute`,
        headers: auth,
        body: '{\n  "method": "GET",\n  "url": "https://api.github.com/zen",\n  "headers": { "Accept": "application/json" }\n}',
        tests: "status == 200\njson:durationMs exists",
      },
    ],
  }
}

function parseHeaders(raw: string) {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error()
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]))
  } catch {
    throw new Error('Headers must be a JSON object, for example { "Authorization": "Bearer token" }.')
  }
}

function applyEnvironment(value: string, environment: Record<string, string>) {
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => environment[key] ?? `{{${key}}}`)
}

function resolveHeaders(raw: string, environment: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(parseHeaders(raw)).map(([name, value]) => [name, applyEnvironment(value, environment)]),
  )
}

function jsonPathExists(value: unknown, path: string) {
  let current = value
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key))
      return false
    current = Reflect.get(current, key)
  }
  return true
}

function evaluateTests(script: string, result: ApiResult): TestResult[] {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((expression) => {
      let pass = false
      let detail = ""
      const status = expression.match(/^status\s*==\s*(\d+)$/i)
      const timing = expression.match(/^response_time\s*<\s*(\d+)$/i)
      const header = expression.match(/^header:([^\s]+)\s+contains\s+(.+)$/i)
      const jsonExists = expression.match(/^json:([^\s]+)\s+exists$/i)
      try {
        if (status) {
          pass = result.status === Number(status[1])
          detail = `received ${result.status}`
        } else if (timing) {
          pass = result.durationMs < Number(timing[1])
          detail = `${result.durationMs} ms`
        } else if (header) {
          const headerName = header[1] ?? ""
          const expected = header[2] ?? ""
          const value = result.headers[headerName.toLowerCase()] || ""
          pass = value.toLowerCase().includes(expected.toLowerCase())
          detail = value || "header missing"
        } else if (jsonExists) {
          const data = JSON.parse(result.body)
          pass = jsonPathExists(data, jsonExists[1] ?? "")
          detail = pass ? "value exists" : "value missing"
        } else {
          detail = "unsupported assertion"
        }
      } catch (error) {
        detail = error instanceof Error ? error.message : "test failed"
      }
      return { expression, pass, valid: Boolean(status || timing || header || jsonExists), detail }
    })
}

export function generatedSnippet(request: RequestDraft, headersText: string, environment: Record<string, string>) {
  let headers: Record<string, string>
  try {
    headers = resolveHeaders(headersText, environment)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Headers must be valid JSON."
    return { code: `// ${message}`, error: message }
  }

  const method = request.method.toUpperCase()
  const resolvedBody = applyEnvironment(request.body, environment)
  const options = [`  method: ${JSON.stringify(method)}`]
  if (Object.keys(headers).length) {
    options.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, "\n  ")}`)
  }
  if (resolvedBody && !["GET", "HEAD"].includes(method)) {
    const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1]
    const looksLikeJson = contentType ? /json/i.test(contentType) : /^\s*(?:\[|\{)/.test(resolvedBody)
    let bodyExpression = JSON.stringify(resolvedBody)
    if (looksLikeJson) {
      try {
        bodyExpression = `JSON.stringify(${JSON.stringify(JSON.parse(resolvedBody), null, 2).replace(/\n/g, "\n  ")})`
      } catch {
        bodyExpression = JSON.stringify(resolvedBody)
      }
    }
    options.push(`  body: ${bodyExpression}`)
  }

  const url = applyEnvironment(request.url, environment)
  return {
    code: `const response = await fetch(${JSON.stringify(url)}, {\n${options.join(",\n")}\n})\n\nconst contentType = response.headers.get("content-type") || ""\nconst responseText = await response.text()\nconst data = responseText && contentType.toLowerCase().includes("json")\n  ? JSON.parse(responseText)\n  : responseText`,
  }
}

function formatHistoryTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Unknown time"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
}

function handleTabKey<T extends string>(
  event: KeyboardEvent<HTMLButtonElement>,
  tabs: readonly T[],
  active: T,
  select: (tab: T) => void,
) {
  let index = tabs.indexOf(active)
  if (event.key === "ArrowRight") index = (index + 1) % tabs.length
  else if (event.key === "ArrowLeft") index = (index - 1 + tabs.length) % tabs.length
  else if (event.key === "Home") index = 0
  else if (event.key === "End") index = tabs.length - 1
  else return
  event.preventDefault()
  select(tabs[index])
  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role='tab']")
  buttons?.[index]?.focus()
}

function isApiResult(value: unknown): value is ApiResult {
  if (value === null || typeof value !== "object") return false
  const encoding = Reflect.get(value, "encoding")
  const headers = Reflect.get(value, "headers")
  return (
    typeof Reflect.get(value, "status") === "number" &&
    typeof Reflect.get(value, "statusText") === "string" &&
    headers !== null &&
    typeof headers === "object" &&
    typeof Reflect.get(value, "body") === "string" &&
    (encoding === "text" || encoding === "base64") &&
    typeof Reflect.get(value, "bytes") === "number" &&
    typeof Reflect.get(value, "durationMs") === "number" &&
    typeof Reflect.get(value, "url") === "string"
  )
}

function formatBody(result?: ApiResult) {
  if (!result) return ""
  if (result.encoding === "base64") {
    return `[Binary response: ${result.bytes} bytes, base64 encoded]\n${result.body}`
  }
  try {
    return JSON.stringify(JSON.parse(result.body), null, 2)
  } catch {
    return result.body
  }
}

export function PlayParkView(props: { session: Session; config?: PlatformConfig }) {
  const [section, setSection] = useState<"overview" | "workbench" | "keys" | "schema" | "usage">("overview")
  const [request, setRequest] = useState<RequestDraft>(emptyRequest)
  const [headersText, setHeadersText] = useState(JSON.stringify(emptyRequest.headers, null, 2))
  const [activeTab, setActiveTab] = useState<"headers" | "body" | "tests" | "code">("headers")
  const [responseTab, setResponseTab] = useState<"body" | "headers" | "tests">("body")
  const [sideTab, setSideTab] = useState<"collections" | "history" | "environments">("collections")
  const [result, setResult] = useState<ApiResult>()
  const [testResults, setTestResults] = useState<TestResult[]>([])
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [environments, setEnvironments] = useState<Environment[]>([])
  const [environment, setEnvironment] = useState<Environment>()
  const [filter, setFilter] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [saveName, setSaveName] = useState("")
  const [envEditor, setEnvEditor] = useState(false)
  const [envName, setEnvName] = useState("")
  const [envValues, setEnvValues] = useState('{\n  "baseUrl": "https://api.example.com"\n}')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([])
  const [usage, setUsage] = useState<Usage>()
  const [schema, setSchema] = useState<OpenApiDocument>()
  const [keyName, setKeyName] = useState("")
  const [createdSecret, setCreatedSecret] = useState("")
  const executionVersion = useRef(0)
  const environmentVersion = useRef(0)

  const load = async () => {
    try {
      const [historyPayload, collectionPayload, environmentPayload] = await Promise.all([
        apiFetch<ItemsPayload<HistoryItem>>("/api/platform/workspace-data?kind=history", props.session),
        apiFetch<ItemsPayload<Collection>>("/api/platform/workspace-data?kind=collections", props.session),
        apiFetch<ItemsPayload<Environment>>("/api/platform/workspace-data?kind=environments", props.session),
      ])
      setHistory(historyPayload.items || [])
      setCollections(collectionPayload.items || [])
      setEnvironments(environmentPayload.items || [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not load Play Park data.")
    }
  }

  const loadPlatform = async () => {
    try {
      const [keysPayload, usagePayload, schemaPayload] = await Promise.all([
        apiFetch<KeysPayload>("/api/platform/api-keys", props.session),
        apiFetch<Usage>("/api/platform/usage", props.session),
        apiFetch<OpenApiDocument>("/api/v1/openapi", props.session),
      ])
      setApiKeys(keysPayload.keys || [])
      setUsage(usagePayload)
      setSchema(schemaPayload)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not load the API platform.")
    }
  }

  useEffect(() => {
    void Promise.all([load(), loadPlatform()])
  }, [props.session.access_token])
  useEffect(() => {
    if (!envEditor) return undefined
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setEnvEditor(false)
    }
    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [envEditor])

  const environmentValues = environment?.values || {}
  const builtInCollection = useMemo(() => vectorApiCollection(location.origin), [])
  const resolvedUrl = useMemo(() => applyEnvironment(request.url, environmentValues), [request.url, environmentValues])
  const visibleCollections = useMemo(
    () =>
      [builtInCollection, ...collections].filter((item) =>
        `${item.name} ${item.description || ""}`.toLowerCase().includes(filter.toLowerCase()),
      ),
    [builtInCollection, collections, filter],
  )
  const visibleHistory = useMemo(
    () => history.filter((item) => `${item.method} ${item.url}`.toLowerCase().includes(filter.toLowerCase())),
    [history, filter],
  )

  const invalidateExecution = () => {
    executionVersion.current += 1
    setResult(undefined)
    setTestResults([])
    setResponseTab("body")
  }

  const updateRequest = (update: (current: RequestDraft) => RequestDraft) => {
    invalidateExecution()
    setRequest(update)
  }

  const updateHeadersText = (value: string) => {
    invalidateExecution()
    setHeadersText(value)
  }

  const send = async () => {
    invalidateExecution()
    const version = executionVersion.current
    setBusy(true)
    setError("")
    try {
      const headers = resolveHeaders(headersText, environmentValues)
      const tests = applyEnvironment(request.tests, environmentValues)
      const payload: unknown = await apiFetch("/api/platform/execute", props.session, {
        method: "POST",
        body: JSON.stringify({
          method: request.method,
          url: resolvedUrl,
          headers,
          body: applyEnvironment(request.body, environmentValues),
          tests,
          timeoutMs: 15_000,
        }),
      })
      if (!isApiResult(payload)) throw new Error("Vector received an invalid API execution response.")
      if (version === executionVersion.current) {
        setResult(payload)
        setTestResults(payload.assertions || evaluateTests(tests, payload))
        setResponseTab("body")
      }
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not send the API request.")
    } finally {
      setBusy(false)
    }
  }

  const saveCollection = async () => {
    const name = (saveName || request.name || "API collection").trim()
    setBusy(true)
    try {
      const existing = collections.find((item) => item.name === name)
      const requests = [
        ...(existing?.requests || []).filter((item) => item.name !== request.name),
        { ...request, headers: safeCollectionHeaders(parseHeaders(headersText)) },
      ]
      await apiFetch("/api/platform/workspace-data?kind=collections", props.session, {
        method: "POST",
        body: JSON.stringify({ id: existing?.id, name, description: "Saved from Vector Play Park", requests }),
      })
      setSaveName("")
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not save the collection.")
    } finally {
      setBusy(false)
    }
  }

  const saveEnvironment = async () => {
    setBusy(true)
    try {
      await apiFetch("/api/platform/workspace-data?kind=environments", props.session, {
        method: "POST",
        body: JSON.stringify({ name: envName, values: JSON.parse(envValues) }),
      })
      setEnvEditor(false)
      setEnvName("")
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Environment values must be valid JSON.")
    } finally {
      setBusy(false)
    }
  }

  const chooseEnvironment = async (item: Environment) => {
    const version = ++environmentVersion.current
    invalidateExecution()
    try {
      const payload = await apiFetch<{ item: Environment }>(
        `/api/platform/workspace-data?kind=environments&id=${encodeURIComponent(item.id)}`,
        props.session,
      )
      if (version === environmentVersion.current) {
        invalidateExecution()
        setEnvironment(payload.item)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not open the environment.")
    }
  }

  const loadDraft = (draft: RequestDraft) => {
    invalidateExecution()
    const normalized: RequestDraft = {
      name: typeof draft.name === "string" && draft.name ? draft.name : "Untitled request",
      method: typeof draft.method === "string" ? draft.method.toUpperCase() : "GET",
      url: typeof draft.url === "string" ? draft.url : "",
      headers:
        draft.headers && typeof draft.headers === "object" && !Array.isArray(draft.headers) ? { ...draft.headers } : {},
      body: typeof draft.body === "string" ? draft.body : "",
      tests: typeof draft.tests === "string" ? draft.tests : "",
    }
    setRequest(normalized)
    setHeadersText(JSON.stringify(normalized.headers, null, 2))
    setMobileSidebarOpen(false)
  }

  const loadHistory = (item: HistoryItem) => {
    loadDraft({
      name: `${item.method.toUpperCase()} history request`,
      method: item.method,
      url: item.url,
      headers: {},
      body: "",
      tests: "",
    })
    setActiveTab("headers")
  }

  const snippet = useMemo(() => {
    return generatedSnippet(request, headersText, environmentValues)
  }, [request, headersText, environmentValues])

  const copySnippet = async () => {
    if (snippet.error) return
    try {
      await navigator.clipboard.writeText(snippet.code)
    } catch {
      setError("Vector could not copy the generated snippet.")
    }
  }

  const createApiKey = async () => {
    if (!keyName.trim()) return
    setBusy(true)
    setError("")
    try {
      const payload = await apiFetch<SecretPayload>("/api/platform/api-keys", props.session, {
        method: "POST",
        body: JSON.stringify({ name: keyName, expiresInDays: 90, dailyUnitLimit: 500 }),
      })
      setCreatedSecret(payload.secret || "")
      setKeyName("")
      await loadPlatform()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not create the API key.")
    } finally {
      setBusy(false)
    }
  }

  const revokeApiKey = async (id: string) => {
    if (!confirm("Revoke this API key? Applications using it will stop working immediately.")) return
    setBusy(true)
    setError("")
    try {
      await apiFetch("/api/platform/api-keys", props.session, { method: "DELETE", body: JSON.stringify({ id }) })
      await loadPlatform()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Vector could not revoke the API key.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="platform-page play-page">
      <span className="play-sr-only" role="status" aria-live="polite">
        {busy
          ? "Play Park is working."
          : result
            ? `Response ${result.status}.${result.evidence ? " Execution evidence saved." : ""}`
            : ""}
      </span>
      <header className="platform-page-header">
        <div className="platform-page-title">
          <span>
            <Braces size={17} />
          </span>
          <div>
            <h1>Vector Play Park</h1>
            <p>Build, debug, save, test, and automate APIs with evidence.</p>
          </div>
        </div>
        <div className="play-head-actions">
          <a className="platform-secondary" href="/api/v1/openapi" target="_blank" rel="noreferrer">
            <Code2 size={14} />
            OpenAPI
          </a>
          <select
            className="platform-select"
            aria-label="Active environment"
            value={environment?.id || ""}
            onChange={(event) => {
              const item = environments.find((value) => value.id === event.target.value)
              if (item) void chooseEnvironment(item)
              else {
                environmentVersion.current += 1
                invalidateExecution()
                setEnvironment(undefined)
              }
            }}
          >
            <option value="">No environment</option>
            {environments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button type="button" className="platform-secondary" onClick={() => setEnvEditor(true)}>
            <Settings2 size={14} />
            Environment
          </button>
        </div>
      </header>

      <nav className="play-platform-nav" aria-label="Vector API Platform">
        {platformSections.map(({ id, label, icon: Icon }) => (
          <button key={id} data-active={section === id} onClick={() => setSection(id)}>
            <Icon size={13} />
            {label}
          </button>
        ))}
      </nav>

      {section === "overview" && (
        <main className="play-platform-overview">
          <section className="play-overview-hero">
            <div>
              <span className="platform-kicker">Vector API Platform</span>
              <h2>Build and verify agentic systems from one workspace.</h2>
              <p>
                Send real requests, test responses, issue scoped keys, launch cloud agents, coordinate agent teams, and
                preserve execution evidence without stitching together separate tools.
              </p>
              <div>
                <button className="platform-primary" onClick={() => setSection("workbench")}>
                  <Play size={14} /> Open workbench
                </button>
                <button className="platform-secondary" onClick={() => setSection("keys")}>
                  <KeyRound size={14} /> Manage keys
                </button>
              </div>
            </div>
            <div className="play-overview-status">
              <span>
                <ShieldCheck size={15} /> Authenticated workspace
              </span>
              <span>
                <CheckCircle2 size={15} /> Server-side evidence capture
              </span>
              <span>
                <Gauge size={15} /> Quotas and cost visibility
              </span>
            </div>
          </section>
          <section className="play-overview-metrics">
            <div>
              <span>API requests</span>
              <strong>{usage?.apiRequests.toLocaleString() || "0"}</strong>
              <small>last 30 days</small>
            </div>
            <div>
              <span>Cloud runs</span>
              <strong>{usage?.cloudRuns.toLocaleString() || "0"}</strong>
              <small>{usage?.activeRuns || 0} active</small>
            </div>
            <div>
              <span>Execution today</span>
              <strong>{usage?.apiExecutionsToday.toLocaleString() || "0"}</strong>
              <small>of {usage?.limits.apiExecutionsPerDay.toLocaleString() || "—"}</small>
            </div>
            <div>
              <span>Active keys</span>
              <strong>{usage?.activeApiKeys.toLocaleString() || "0"}</strong>
              <small>scoped credentials</small>
            </div>
          </section>
          <section className="play-capability-grid">
            <button onClick={() => setSection("workbench")}>
              <Braces size={17} />
              <span>
                <strong>Request workbench</strong>
                <small>Compose requests, inject environments, inspect responses, and save collections.</small>
              </span>
            </button>
            <button onClick={() => setSection("workbench")}>
              <CheckCircle2 size={17} />
              <span>
                <strong>Tests and evidence</strong>
                <small>Assert status, timing, headers, and JSON paths. Every run is saved with evidence.</small>
              </span>
            </button>
            <button onClick={() => setSection("schema")}>
              <Bot size={17} />
              <span>
                <strong>Agent APIs</strong>
                <small>Launch isolated agents, continue sessions, coordinate teams, and inspect results.</small>
              </span>
            </button>
            <button onClick={() => setSection("keys")}>
              <KeyRound size={17} />
              <span>
                <strong>Scoped access</strong>
                <small>Create expiring credentials with per-key scopes and daily execution limits.</small>
              </span>
            </button>
            <button onClick={() => setSection("workbench")}>
              <Folder size={17} />
              <span>
                <strong>Collections and environments</strong>
                <small>Reuse requests safely while encrypted environment values stay server-side.</small>
              </span>
            </button>
            <button onClick={() => setSection("usage")}>
              <BarChart3 size={17} />
              <span>
                <strong>Platform usage</strong>
                <small>Track agent launches, turns, tokens, cost, API calls, keys, and connected tools.</small>
              </span>
            </button>
          </section>
          <section className="play-endpoint-strip">
            <header>
              <div>
                <span className="platform-kicker">Production endpoints</span>
                <h3>One API for execution and autonomous work</h3>
              </div>
              <button className="platform-secondary" onClick={() => setSection("schema")}>
                <BookOpen size={13} /> Full reference
              </button>
            </header>
            {Object.entries(schema?.paths || {}).map(([path, methods]) =>
              Object.entries(methods).map(([method, operation]) => (
                <div key={`${method}-${path}`}>
                  <em data-method={method}>{method.toUpperCase()}</em>
                  <code>{path}</code>
                  <span>{operation.summary || "Vector API endpoint"}</span>
                </div>
              )),
            )}
          </section>
        </main>
      )}

      {section === "keys" && (
        <main className="play-platform-section">
          <header>
            <div>
              <span className="platform-kicker">Credentials</span>
              <h2>API keys</h2>
              <p>Create scoped, expiring keys for applications that use Vector outside this dashboard.</p>
            </div>
          </header>
          <section className="play-key-create">
            <label>
              Key name
              <input
                className="platform-input"
                value={keyName}
                onChange={(event) => setKeyName(event.target.value)}
                placeholder="Production backend"
                maxLength={80}
              />
            </label>
            <div>
              <span>Default access</span>
              <small>Agents read/write · API execute · 500 units/day · expires in 90 days</small>
            </div>
            <button className="platform-primary" onClick={() => void createApiKey()} disabled={busy || !keyName.trim()}>
              <Plus size={13} /> Create key
            </button>
          </section>
          {createdSecret && (
            <section className="play-created-secret">
              <div>
                <ShieldCheck size={16} />
                <span>
                  <strong>Copy this key now</strong>
                  <small>For security, Vector will not show it again.</small>
                </span>
              </div>
              <code>{createdSecret}</code>
              <button className="platform-secondary" onClick={() => void navigator.clipboard.writeText(createdSecret)}>
                <Copy size={13} /> Copy
              </button>
              <button
                className="platform-icon-button"
                aria-label="Hide generated key"
                onClick={() => setCreatedSecret("")}
              >
                <XCircle size={13} />
              </button>
            </section>
          )}
          <section className="play-key-list">
            {apiKeys
              .filter((key) => !key.revoked_at)
              .map((key) => (
                <article key={key.id}>
                  <span>
                    <KeyRound size={15} />
                  </span>
                  <div>
                    <strong>{key.name}</strong>
                    <code>
                      {key.secret_prefix}••••{key.last_four}
                    </code>
                    <small>
                      {key.scopes.join(" · ")} · {key.daily_unit_limit.toLocaleString()} units/day
                    </small>
                  </div>
                  <div>
                    <small>{key.last_used_at ? `Used ${formatHistoryTime(key.last_used_at)}` : "Never used"}</small>
                    <small>{key.expires_at ? `Expires ${formatHistoryTime(key.expires_at)}` : "No expiry"}</small>
                  </div>
                  <button
                    className="platform-icon-button"
                    aria-label={`Revoke ${key.name}`}
                    onClick={() => void revokeApiKey(key.id)}
                    disabled={busy}
                  >
                    <Trash2 size={13} />
                  </button>
                </article>
              ))}
            {!apiKeys.some((key) => !key.revoked_at) && (
              <div className="play-section-empty">
                <KeyRound size={22} />
                <p>No active API keys.</p>
              </div>
            )}
          </section>
        </main>
      )}

      {section === "schema" && (
        <main className="play-platform-section">
          <header>
            <div>
              <span className="platform-kicker">OpenAPI {schema?.info?.version || "1.1"}</span>
              <h2>API reference</h2>
              <p>{schema?.info?.description}</p>
            </div>
            <a className="platform-secondary" href="/api/v1/openapi" target="_blank" rel="noreferrer">
              <Code2 size={13} /> Raw OpenAPI
            </a>
          </header>
          <section className="play-schema-list">
            {Object.entries(schema?.paths || {}).map(([path, methods]) =>
              Object.entries(methods).map(([method, operation]) => (
                <article key={`${method}-${path}`}>
                  <header>
                    <em data-method={method}>{method.toUpperCase()}</em>
                    <code>{path}</code>
                  </header>
                  <h3>{operation.summary || "Vector API endpoint"}</h3>
                  <p>{operation.description || "Authenticated with a scoped x-vector-api-key header."}</p>
                  <button
                    className="platform-secondary"
                    onClick={() => {
                      setSection("workbench")
                      loadDraft({
                        name: operation.summary || `${method} ${path}`,
                        method: method.toUpperCase(),
                        url: `${location.origin}${path}`,
                        headers: { "X-Vector-API-Key": "{{vectorApiKey}}", "Content-Type": "application/json" },
                        body: method.toLowerCase() === "get" ? "" : "{}",
                        tests: "status == 200",
                      })
                    }}
                  >
                    <Play size={12} /> Try in workbench
                  </button>
                </article>
              )),
            )}
          </section>
        </main>
      )}

      {section === "usage" && (
        <main className="play-platform-section">
          <header>
            <div>
              <span className="platform-kicker">Last {usage?.periodDays || 30} days</span>
              <h2>Platform usage</h2>
              <p>Real account activity and enforced limits for API execution and cloud agents.</p>
            </div>
            <button className="platform-secondary" onClick={() => void loadPlatform()}>
              <RefreshCw size={13} /> Refresh
            </button>
          </header>
          <section className="play-usage-grid">
            <UsageCard
              label="API executions today"
              value={usage?.apiExecutionsToday || 0}
              limit={usage?.limits.apiExecutionsPerDay}
            />
            <UsageCard
              label="Agent launches"
              value={usage?.cloudLaunchesUsed || 0}
              limit={usage?.limits.cloudAgentLaunches30Days}
            />
            <UsageCard
              label="Agent follow-ups"
              value={usage?.cloudTurnsUsed || 0}
              limit={usage?.limits.cloudAgentTurns30Days}
            />
            <UsageCard
              label="Concurrent agents"
              value={usage?.activeRuns || 0}
              limit={usage?.limits.activeCloudAgents}
            />
            <UsageCard label="Cloud tokens" value={usage?.cloudTokens || 0} />
            <UsageCard label="Cloud cost" value={`$${(usage?.cloudCostUsd || 0).toFixed(4)}`} />
            <UsageCard label="Completed runs" value={usage?.completedRuns || 0} />
            <UsageCard label="Connected tools" value={usage?.connectedTools || 0} />
          </section>
        </main>
      )}

      {section === "workbench" && (
        <>
          <button
            type="button"
            className="play-mobile-sidebar-toggle"
            aria-controls="play-sidebar"
            aria-expanded={mobileSidebarOpen}
            onClick={() => setMobileSidebarOpen((open) => !open)}
          >
            <PanelLeft size={14} />
            {mobileSidebarOpen ? "Close workspace" : "Open workspace"}
          </button>

          <div className="play-workbench">
            <aside
              id="play-sidebar"
              className="play-sidebar"
              data-mobile-open={mobileSidebarOpen}
              aria-label="Play Park workspace"
            >
              <div className="platform-tabs" role="tablist" aria-label="Workspace views">
                {sideTabs.map((tab) => {
                  const label = tab === "environments" ? "Environments" : tab[0].toUpperCase() + tab.slice(1)
                  const Icon = tab === "collections" ? Folder : tab === "history" ? History : Braces
                  return (
                    <button
                      key={tab}
                      id={`play-side-tab-${tab}`}
                      type="button"
                      role="tab"
                      aria-selected={sideTab === tab}
                      aria-controls={`play-side-panel-${tab}`}
                      tabIndex={sideTab === tab ? 0 : -1}
                      data-active={sideTab === tab}
                      onClick={() => setSideTab(tab)}
                      onKeyDown={(event) => handleTabKey(event, sideTabs, sideTab, setSideTab)}
                    >
                      <Icon size={12} />
                      {label}
                    </button>
                  )
                })}
              </div>
              <label className="play-side-search">
                <Search size={12} />
                <span className="play-sr-only">Filter {sideTab}</span>
                <input
                  aria-label={`Filter ${sideTab}`}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter"
                />
              </label>
              {sideTab === "collections" ? (
                <div
                  id="play-side-panel-collections"
                  className="play-tree"
                  role="tabpanel"
                  aria-labelledby="play-side-tab-collections"
                >
                  {visibleCollections.map((collection) => (
                    <section key={collection.id} aria-label={collection.name}>
                      <strong>
                        <Folder size={12} />
                        {collection.name}
                        <span>{collection.requests?.length || 0}</span>
                      </strong>
                      {collection.requests?.map((draft, index) => (
                        <button type="button" key={`${draft.name}-${index}`} onClick={() => loadDraft(draft)}>
                          <em data-method={draft.method}>{draft.method}</em>
                          <span>{draft.name}</span>
                        </button>
                      ))}
                    </section>
                  ))}
                  {!visibleCollections.length && <p>No matching collections. Save this request to start one.</p>}
                </div>
              ) : sideTab === "history" ? (
                <div
                  id="play-side-panel-history"
                  className="play-history"
                  role="tabpanel"
                  aria-labelledby="play-side-tab-history"
                >
                  {visibleHistory.map((item) => {
                    const assertions = item.response_summary?.assertions
                    return (
                      <button
                        type="button"
                        key={item.id}
                        aria-label={`Load ${item.method} ${item.url} from history`}
                        onClick={() => loadHistory(item)}
                      >
                        <em data-method={item.method}>{item.method}</em>
                        <span>{item.url}</span>
                        <small>
                          <span>{item.status ?? "No status"}</span>
                          <span>{item.duration_ms == null ? "No timing" : `${item.duration_ms} ms`}</span>
                          {item.response_bytes != null && <span>{item.response_bytes} B</span>}
                        </small>
                        <time dateTime={item.created_at}>
                          {formatHistoryTime(item.created_at)}
                          {assertions && assertions.total > 0
                            ? ` · ${assertions.passed}/${assertions.total} passed${assertions.invalid ? `, ${assertions.invalid} invalid` : ""}`
                            : ""}
                        </time>
                      </button>
                    )
                  })}
                  {!visibleHistory.length && <p className="play-side-empty">No matching execution history.</p>}
                </div>
              ) : (
                <div
                  id="play-side-panel-environments"
                  className="play-environments"
                  role="tabpanel"
                  aria-labelledby="play-side-tab-environments"
                >
                  {environments.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      aria-pressed={item.id === environment?.id}
                      data-active={item.id === environment?.id}
                      onClick={() => {
                        setMobileSidebarOpen(false)
                        void chooseEnvironment(item)
                      }}
                    >
                      <Braces size={12} />
                      <span>{item.name}</span>
                    </button>
                  ))}
                  <button type="button" className="play-add-env" onClick={() => setEnvEditor(true)}>
                    <Plus size={12} />
                    New environment
                  </button>
                </div>
              )}
            </aside>

            <main className="play-main" aria-busy={busy}>
              <div className="play-request-title">
                <label className="play-sr-only" htmlFor="play-request-name">
                  Request name
                </label>
                <input
                  id="play-request-name"
                  value={request.name}
                  onChange={(event) => updateRequest((current) => ({ ...current, name: event.target.value }))}
                />
                <div>
                  <label className="play-sr-only" htmlFor="play-collection-name">
                    Collection name
                  </label>
                  <input
                    id="play-collection-name"
                    value={saveName}
                    onChange={(event) => setSaveName(event.target.value)}
                    placeholder="Collection name"
                  />
                  <button type="button" className="platform-secondary" onClick={saveCollection} disabled={busy}>
                    <Save size={13} />
                    Save
                  </button>
                </div>
              </div>
              <div className="play-url">
                <label className="play-sr-only" htmlFor="play-method">
                  HTTP method
                </label>
                <select
                  id="play-method"
                  value={request.method}
                  onChange={(event) => updateRequest((current) => ({ ...current, method: event.target.value }))}
                >
                  {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((method) => (
                    <option key={method}>{method}</option>
                  ))}
                </select>
                <label className="play-sr-only" htmlFor="play-url">
                  Request URL
                </label>
                <input
                  id="play-url"
                  inputMode="url"
                  value={request.url}
                  onChange={(event) => updateRequest((current) => ({ ...current, url: event.target.value }))}
                  placeholder="https://api.example.com/v1/resource"
                />
                <button
                  type="button"
                  className="platform-primary"
                  onClick={send}
                  disabled={busy || !request.url.trim()}
                >
                  {busy ? <Clock3 size={14} /> : <Play size={14} />}
                  {busy ? "Sending" : "Send"}
                </button>
              </div>
              <div className="platform-tabs play-tabs" role="tablist" aria-label="Request details">
                {requestTabs.map((tab) => (
                  <button
                    key={tab}
                    id={`play-request-tab-${tab}`}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab}
                    aria-controls={`play-request-panel-${tab}`}
                    tabIndex={activeTab === tab ? 0 : -1}
                    data-active={activeTab === tab}
                    onClick={() => setActiveTab(tab)}
                    onKeyDown={(event) => handleTabKey(event, requestTabs, activeTab, setActiveTab)}
                  >
                    {tab[0].toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>
              <div
                id={`play-request-panel-${activeTab}`}
                className="play-editor"
                role="tabpanel"
                aria-labelledby={`play-request-tab-${activeTab}`}
              >
                {activeTab === "headers" ? (
                  <>
                    <div className="play-editor-hint">
                      <span>JSON header object</span>
                      <small>Sensitive headers are sent once and never stored in request history.</small>
                    </div>
                    <textarea
                      aria-label="Request headers as JSON"
                      value={headersText}
                      onChange={(event) => updateHeadersText(event.target.value)}
                      spellCheck={false}
                    />
                  </>
                ) : activeTab === "body" ? (
                  <>
                    <div className="play-editor-hint">
                      <span>Request body</span>
                      <small>Use {"{{variable}}"} to insert the selected environment.</small>
                    </div>
                    <textarea
                      aria-label="Request body"
                      value={request.body}
                      onChange={(event) => updateRequest((current) => ({ ...current, body: event.target.value }))}
                      spellCheck={false}
                      placeholder={'{\n  "name": "Vector"\n}'}
                    />
                  </>
                ) : activeTab === "tests" ? (
                  <>
                    <div className="play-editor-hint">
                      <span>Assertions</span>
                      <small>Supported: status, response_time, header contains, and json path exists.</small>
                    </div>
                    <textarea
                      aria-label="Response assertions"
                      value={request.tests}
                      onChange={(event) => updateRequest((current) => ({ ...current, tests: event.target.value }))}
                      spellCheck={false}
                    />
                  </>
                ) : (
                  <>
                    <div className="play-editor-hint">
                      <span>JavaScript fetch</span>
                      <button
                        type="button"
                        disabled={Boolean(snippet.error)}
                        title={snippet.error}
                        onClick={() => void copySnippet()}
                      >
                        <Copy size={12} />
                        Copy
                      </button>
                    </div>
                    <pre tabIndex={0}>{snippet.code}</pre>
                  </>
                )}
              </div>
              <section className="play-response" aria-label="API response">
                <header>
                  <div className="platform-tabs" role="tablist" aria-label="Response details">
                    {responseTabs.map((tab) => (
                      <button
                        key={tab}
                        id={`play-response-tab-${tab}`}
                        type="button"
                        role="tab"
                        aria-selected={responseTab === tab}
                        aria-controls={`play-response-panel-${tab}`}
                        tabIndex={responseTab === tab ? 0 : -1}
                        data-active={responseTab === tab}
                        onClick={() => setResponseTab(tab)}
                        onKeyDown={(event) => handleTabKey(event, responseTabs, responseTab, setResponseTab)}
                      >
                        {tab === "body"
                          ? "Response"
                          : tab === "headers"
                            ? "Headers"
                            : `Test results${testResults.length ? ` (${testResults.filter((item) => item.pass).length}/${testResults.length})` : ""}`}
                      </button>
                    ))}
                  </div>
                  {result && (
                    <div className="play-response-meta" aria-live="polite">
                      <span data-good={result.status < 400}>
                        {result.status} {result.statusText}
                      </span>
                      <span>{result.durationMs} ms</span>
                      <span>{result.bytes} B</span>
                      {result.evidence && (
                        <span className="play-evidence" title={formatHistoryTime(result.evidence.createdAt)}>
                          <CheckCircle2 size={11} />
                          Saved
                        </span>
                      )}
                    </div>
                  )}
                </header>
                <div
                  id={`play-response-panel-${responseTab}`}
                  className="play-response-panel"
                  role="tabpanel"
                  aria-labelledby={`play-response-tab-${responseTab}`}
                >
                  {!result ? (
                    <div className="play-response-empty">
                      <Code2 size={24} />
                      <p>Send a request to inspect its response, headers, timing, size, and assertions.</p>
                    </div>
                  ) : responseTab === "body" ? (
                    <pre tabIndex={0}>{formatBody(result)}</pre>
                  ) : responseTab === "headers" ? (
                    <pre tabIndex={0}>{JSON.stringify(result.headers, null, 2)}</pre>
                  ) : testResults.length ? (
                    <div className="play-tests" role="list">
                      {testResults.map((test, index) => (
                        <div
                          role="listitem"
                          key={`${test.expression}-${index}`}
                          data-pass={test.pass}
                          data-valid={test.valid}
                        >
                          <span className="play-sr-only">
                            {test.pass ? "Passed" : test.valid ? "Failed" : "Invalid"}:{" "}
                          </span>
                          {test.pass ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                          <span>
                            <strong>{test.expression}</strong>
                            <small>{test.detail}</small>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="play-response-empty">
                      <p>No assertions were included in this execution.</p>
                    </div>
                  )}
                </div>
              </section>
            </main>
          </div>
        </>
      )}

      {error && (
        <div className="agents-toast" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError("")}>
            <XCircle size={14} />
          </button>
        </div>
      )}
      {envEditor && (
        <div
          className="platform-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEnvEditor(false)
          }}
        >
          <div className="platform-modal" role="dialog" aria-modal="true" aria-labelledby="play-environment-title">
            <div className="platform-modal-head">
              <div>
                <h2 id="play-environment-title">New environment</h2>
                <p>Values are encrypted before they are stored.</p>
              </div>
              <button
                type="button"
                className="platform-icon-button"
                aria-label="Close environment editor"
                onClick={() => setEnvEditor(false)}
              >
                <XCircle size={15} />
              </button>
            </div>
            <div className="platform-form-grid">
              <label>
                Environment name
                <input
                  autoFocus
                  className="platform-input"
                  value={envName}
                  onChange={(event) => setEnvName(event.target.value)}
                  placeholder="Production"
                />
              </label>
              <label>
                Variables as JSON
                <textarea
                  className="platform-textarea platform-mono"
                  value={envValues}
                  onChange={(event) => setEnvValues(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <div className="platform-form-actions">
                <button type="button" className="platform-secondary" onClick={() => setEnvEditor(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="platform-primary"
                  onClick={saveEnvironment}
                  disabled={busy || !envName.trim()}
                >
                  Save environment
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
