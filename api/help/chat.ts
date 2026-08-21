import {
  ApiError,
  handleApiError,
  json,
  readJson,
  requireMethod,
  type ApiRequest,
  type ApiResponse,
} from "../_lib/http.js"
import { enforceRateLimit, requireTrustedJsonRequest } from "../_lib/abuse.js"

// Groq proxy for the Vector Help AI assistant. The key stays server-side so the
// desktop bundle never ships it. Requests are capped and the model is pinned
// here rather than taken from the client, so a leaked endpoint cannot be turned
// into a general-purpose inference gateway.
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
// Groq retires hosted models without notice, and a retired id fails as a 404
// on every request — which is what took the help assistant offline: the pinned
// llama-3.3-70b-versatile stopped existing. Check
// https://api.groq.com/openai/v1/models when help starts returning
// HELP_UPSTREAM_404, and prefer a model that returns plain content: several
// Groq models are reasoning models that emit a separate `reasoning` field, and
// at least one (qwen3.6) writes its <think> block into `content` itself.
const MODEL = process.env.GROQ_HELP_MODEL || "openai/gpt-oss-120b"
const MAX_TURNS = 24
const MAX_CHARS = 6_000
const MAX_CONTEXT_CHARS = 24_000
const MAX_OUTPUT_TOKENS = 1_024

// The desktop currently sends the documentation blocks selected by its local
// help index. Treat that text only as a selection hint: copying it into a
// system message would let any caller turn this funded endpoint into an
// arbitrary system-prompt proxy. The actual text below is server-owned.
const PRODUCT_DOCUMENTATION = [
  {
    section: "Start here",
    title: "New project session",
    where: "The gradient button at the top of the sidebar — or ⌘N (Ctrl+N on Windows/Linux).",
    body: "Start a fresh project session, describe one result in plain language, and press Enter. The Vector agent can plan, edit files, run commands, and narrate its work. The model chip in the composer shows the active model.",
  },
  {
    section: "Start here",
    title: "Overview",
    where: "The house icon at the top of the sidebar — Vector's home.",
    body: "Open a project, start a focused session, resume a searchable recent session, and view local activity such as token use, completed chats, and favorite model.",
  },
  {
    section: "Start here",
    title: "Code it yourself",
    where: "Project tools → Code editor.",
    body: "Search for a file and edit it directly. Manual edits and agent edits share the active project, so users can handle precise changes themselves and delegate broader work.",
  },
  {
    section: "Start here",
    title: "Work with one agent",
    where: "Start a project session and describe the outcome in the message box.",
    body: "The main agent can inspect the project, plan, edit, run Terminal commands, operate the visible Browser, and repair failures. Users can steer it, change model or effort, and inspect the result.",
  },
  {
    section: "Start here",
    title: "Work with multiple agents",
    where: "Use New workspace under the active project in the sidebar.",
    body: "Launch isolated agents for separate parts of a project. Each receives its own worktree, conversation, files, and command history. Review its diff and checks before merging trusted work.",
  },
  {
    section: "Cloud Services",
    title: "Deployments",
    where: "Cloud Services → Deployments.",
    body: "Publish through the user's own Vercel or Netlify account. Builds run on that account, and completed deployments appear with their live URLs. If no publisher is detected, Vector provides setup guidance.",
  },
  {
    section: "Cloud Services",
    title: "Observability",
    where: "Cloud Services → Observability.",
    body: "Check deployed URLs and view HTTP status, response time, last-check time, and network failures. Results remain scoped to the current project session.",
  },
  {
    section: "Cloud Services",
    title: "Domains",
    where: "Cloud Services → Domains.",
    body: "Add a domain, see the CNAME record to create, and use Verify to check DNS. Domain lists are scoped per project.",
  },
  {
    section: "Cloud Services",
    title: "Environment variables",
    where: "Cloud Services → Environment.",
    body: "Manage project key-value configuration and apply it to the project's .env file. Put secrets here instead of pasting them into chat.",
  },
  {
    section: "Cloud Services",
    title: "Database",
    where: "Cloud Services → Database.",
    body: "Connect a Supabase project using values from Supabase Settings → API. Vector writes configuration to .env and adds a configured client in src/lib.",
  },
  {
    section: "Cloud Services",
    title: "Build & runtime",
    where: "Cloud Services → Build & runtime.",
    body: "Detect and configure the framework, package manager, install command, build command, output directory, and Node requirement for the repository.",
  },
  {
    section: "Agents",
    title: "Scheduled runs",
    where: "Agents group in the sidebar.",
    body: "Write a prompt, choose a date and time, and run it later. Desktop can launch it at the scheduled time; other environments save it and prompt the user to load and run it. Open a project first.",
  },
  {
    section: "Agents",
    title: "Agent tabs",
    where: "Inside every active project.",
    body: "Launch specialists in isolated git worktrees or managed copies. Each has its own model, conversation, tools, terminal activity, and changes. Review guardrails and diffs before merging.",
  },
  {
    section: "Agents",
    title: "MCP",
    where: "Agents group in the sidebar.",
    body: "Connect Model Context Protocol servers to give agents their exposed tools, such as database, API, or internal-service capabilities.",
  },
  {
    section: "Project tools",
    title: "Canvas",
    where: "Project group in the sidebar.",
    body: "Arrange project tools in floating windows and use the editor, terminal, review, browser, scheduled work, MCP connections, and coding agents together. Canvas accepts voice or typed commands.",
  },
  {
    section: "Project tools",
    title: "Code editor",
    where: "Project group in the sidebar — also called Codespace — inside an active task.",
    body: "Edit project files, inspect Problems, use Find in project, and send the current file and its problems to AI Architect for a focused agent pass.",
  },
  {
    section: "Project tools",
    title: "Browser",
    where: "Project group in the sidebar, inside an active task.",
    body: "Use a real controlled browser beside chat. Vector can inspect and operate that visible page while reading DOM state, console output, runtime failures, and network errors.",
  },
  {
    section: "Project tools",
    title: "Review changes",
    where: "Project group in the sidebar, inside an active task.",
    body: "Inspect task changes as diffs before accepting them. Files show additions, deletions, and a Low, Medium, or High risk indication.",
  },
  {
    section: "Project tools",
    title: "Terminal",
    where: "Project group in the sidebar, inside an active task.",
    body: "Open a real shell in the project directory to run development servers, git commands, package installs, and other commands. It requires an active task.",
  },
  {
    section: "Your safety net",
    title: "Code Archaeology",
    where: "Inside a task — open it from the session's side panel.",
    body: "Vector captures checkpoints when an agent edits files. Inspect touched-file diffs, rename and annotate checkpoints, or restore stored file snapshots to undo an agent run.",
  },
  {
    section: "Everyday flow",
    title: "Dictation",
    where: "The mic button in the message composer.",
    body: "Speak a prompt and edit the transcript before sending. Desktop transcription uses a local Whisper model; the web build uses browser speech recognition. Canvas uses the same input path.",
  },
  {
    section: "Everyday flow",
    title: "Push to GitHub or GitLab",
    where: "Cloud Services → Integrations, after choosing a repository.",
    body: "Commit and push the selected repository using an existing origin or a repository created through the connected GitHub or GitLab account.",
  },
  {
    section: "Everyday flow",
    title: "Settings",
    where: "The gear at the bottom of the sidebar.",
    body: "Configure model providers, visible models, keybindings, and appearance. Provider credentials belong in the provider setup rather than chat messages.",
  },
] as const

const COMMON_WORDS = new Set([
  "about",
  "and",
  "can",
  "does",
  "for",
  "from",
  "how",
  "into",
  "the",
  "this",
  "use",
  "vector",
  "what",
  "where",
  "with",
])

function documentationKey(title: string, section: string) {
  return `${title}\u0000${section}`
}

function documentationFor(selectionHint: string, question: string) {
  const requested = new Set(
    [...selectionHint.matchAll(/^## ([^\r\n]{1,120}) \(([^\r\n]{1,80})\)$/gm)].map((match) =>
      documentationKey(match[1] ?? "", match[2] ?? ""),
    ),
  )
  const selected = PRODUCT_DOCUMENTATION.filter((doc) => requested.has(documentationKey(doc.title, doc.section))).slice(
    0,
    5,
  )
  const terms = [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 2 && !COMMON_WORDS.has(term)),
    ),
  ]
  const relevant = selected.length
    ? selected
    : PRODUCT_DOCUMENTATION.map((doc) => ({
        doc,
        score: terms.reduce(
          (score, term) =>
            score +
            (doc.title.toLowerCase().includes(term)
              ? 4
              : doc.where.toLowerCase().includes(term)
                ? 2
                : doc.body.toLowerCase().includes(term)
                  ? 1
                  : 0),
          0,
        ),
      }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((entry) => entry.doc)
  return relevant.map((doc) => `## ${doc.title} (${doc.section})\nWhere: ${doc.where}\n${doc.body}`).join("\n\n")
}

// The assistant is grounded: the app selects matching documentation with each
// question, and the endpoint resolves those selectors against its canonical
// copy above. An ungrounded model invents buttons and menu paths that do not
// exist, so answering outside these docs is forbidden.
const SYSTEM_PROMPT = `You are the Vector Help AI Assistant, built into the Vector desktop app.

Vector is a local-first AI engineering workspace. You help users understand and operate Vector itself.

You will be given DOCUMENTATION sections from Vector's own help corpus. That documentation is your ONLY source of truth about what Vector can do and where its controls live.

Hard rules:
- Answer strictly from the supplied DOCUMENTATION. Never rely on memory of other tools or on what seems plausible for an app like this.
- NEVER invent a button, panel, menu path, sidebar item, keyboard shortcut, or setting. If the documentation does not name a specific control, describe the capability without naming a control.
- If the documentation does not cover the question, say plainly that it is not covered and suggest the closest thing that is documented. Do not guess.
- Only discuss Vector. For anything unrelated, say you only cover Vector.
- Never ask for or repeat API keys, tokens, or passwords.
- Be concise and concrete. Plain prose and short lists, no headings.`

type ChatTurn = { role: "user" | "assistant"; content: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

function isChatTurn(value: unknown): value is ChatTurn {
  if (!isRecord(value)) return false
  return (value.role === "user" || value.role === "assistant") && typeof value.content === "string"
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  try {
    requireMethod(request, "POST")
    requireTrustedJsonRequest(request, 96_000)
    await enforceRateLimit(request, response, { scope: "help-ip", limit: 12, windowSeconds: 10 * 60 })
    const body = await readJson<unknown>(request, 96_000)
    if (!isRecord(body)) {
      throw new ApiError(400, "INVALID_JSON", "The request body must be a JSON object.")
    }
    if (body.context !== undefined && typeof body.context !== "string") {
      throw new ApiError(400, "INVALID_CONTEXT", "Help context must be text.")
    }
    if (body.messages !== undefined && !Array.isArray(body.messages)) {
      throw new ApiError(400, "INVALID_MESSAGES", "Messages must be a list.")
    }
    if (typeof body.context === "string" && body.context.length > MAX_CONTEXT_CHARS) {
      throw new ApiError(400, "CONTEXT_TOO_LARGE", "Help context is too large.")
    }
    const turns = (body.messages ?? [])
      .filter(isChatTurn)
      .slice(-MAX_TURNS)
      .map((turn) => ({ role: turn.role, content: turn.content.slice(0, MAX_CHARS) }))
    if (!turns.length) throw new ApiError(400, "EMPTY_MESSAGES", "Send at least one message.")
    if (turns.at(-1)?.role !== "user") {
      throw new ApiError(400, "INVALID_MESSAGES", "The last message must come from the user.")
    }
    const documentation = documentationFor(body.context ?? "", turns.at(-1)?.content ?? "")
    const groqKey = process.env.GROQ_API_KEY
    if (!groqKey) throw new ApiError(503, "HELP_NOT_CONFIGURED", "The Vector help assistant is not configured.")

    const upstream = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${groqKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "system",
            content: documentation
              ? `DOCUMENTATION:\n\n${documentation}`
              : "DOCUMENTATION:\n\n(none matched this question)\n\nTell the user this is not covered by Vector's help documentation and suggest they rephrase. Do not answer from memory.",
          },
          ...turns,
        ],
      }),
    })

    if (!upstream.ok) {
      // The upstream body can echo account details, so it is logged rather than
      // returned. The status code is safe to surface and is the difference
      // between a rejected key, a bad model id, and a rate limit — without it
      // every failure looks identical from the client.
      console.error("Groq help request failed", upstream.status, await upstream.text().catch(() => ""))
      throw new ApiError(
        502,
        `HELP_UPSTREAM_${upstream.status}`,
        `The help assistant is unavailable right now (upstream ${upstream.status}).`,
      )
    }

    const payload: unknown = await upstream.json()
    const choice = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined
    const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined
    const reply = typeof message?.content === "string" ? message.content.trim() : ""
    if (!reply) {
      // A reasoning model that exhausts max_tokens while still thinking returns
      // finish_reason "length" with empty content. That is a budget problem, not
      // an upstream fault, and it needs a different message from a genuinely
      // empty completion or the cause is impossible to tell apart.
      if (isRecord(choice) && choice.finish_reason === "length") {
        throw new ApiError(
          502,
          "HELP_TRUNCATED",
          "The help assistant ran out of room before it finished answering. Try a narrower question.",
        )
      }
      throw new ApiError(502, "HELP_EMPTY", "The help assistant returned an empty response.")
    }
    json(response, 200, { reply, model: MODEL })
  } catch (error) {
    handleApiError(response, error)
  }
}
