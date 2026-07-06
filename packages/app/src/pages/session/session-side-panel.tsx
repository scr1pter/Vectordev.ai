import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  snippetCompletion,
  type Completion,
  type CompletionContext,
} from "@codemirror/autocomplete"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
} from "@codemirror/language"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { highlightSelectionMatches } from "@codemirror/search"
import { EditorState, type Extension } from "@codemirror/state"
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightWhitespace,
  keymap,
  lineNumbers as codeMirrorLineNumbers,
  rectangularSelection,
} from "@codemirror/view"
import { tags as t } from "@lezer/highlight"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"

import FileTree, { type Kind } from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  createOpenSessionFileTab,
  createSessionTabs,
  getTabReorderIndex,
  shouldShowFileTree,
  type Sizing,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { showToast } from "@/utils/toast"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

type CodespaceView =
  | "editor"
  | "preview"
  | "problems"
  | "changes"
  | "history"
  | "debugger"
  | "architect"
  | "coprogrammer"

type CodespaceToolView = Extract<CodespaceView, "debugger" | "architect" | "coprogrammer">

type CodespaceCheckpoint = {
  id: string
  path: string
  title: string
  content: string
  createdAt: number
}

type CodespaceProblem = {
  severity: "error" | "warning" | "info"
  line: number
  message: string
}

type CodespaceQueuedChange = {
  id: string
  path: string
  name: string
  oldContent: string
  newContent: string
  source: string
  createdAt: number
}

type CodespaceArchitectMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  createdAt: number
}

type CodespaceAgentLog = {
  status: "done" | "warn" | "error" | "info"
  label: string
  detail: string
}

type AiChangeCheckpointSnapshot = {
  path: string
  content: string
}

type AiChangeCheckpoint = {
  id: string
  session: string
  title: string
  files: string[]
  createdAt: number
  documentation?: string
  snapshots?: AiChangeCheckpointSnapshot[]
}

type EngineeringTimelineEntry = {
  id: string
  createdAt: number
  timeLabel?: string
  kind: "edit" | "checkpoint" | "review"
  title: string
  detail: string
  files: string[]
  risk?: "Low" | "Medium" | "High"
  additions?: number
  deletions?: number
}

type VectorReportFile = {
  path: string
  content: string
}

type VectorReportProblem = {
  severity: "error" | "warning" | "info"
  path: string
  message: string
}

type VectorLocalReport = {
  scannedAt: number
  fileCount: number
  lineCount: number
  charCount: number
  languageRows: Array<{ label: string; files: number; lines: number }>
  entrypoints: string[]
  frameworks: string[]
  runCommands: string[]
  problems: VectorReportProblem[]
  preview: {
    status: "ready" | "warning" | "blocked"
    title: string
    details: string[]
  }
  cost: {
    estimatedTokens: number
    risk: "Low" | "Medium" | "High"
    guidance: string[]
  }
  memory: {
    summary: string
    importantFiles: string[]
    nextSteps: string[]
  }
  promptGuard: {
    verdict: string
    suggestions: string[]
  }
  demoChecklist: string[]
}

const CODESPACE_CHECKPOINTS_KEY = "vector.codespace.checkpoints.v1"
const AI_CHANGE_CHECKPOINTS_KEY = "vector.ai-change-checkpoints.v1"

function textFromFileReadResponse(result: unknown) {
  const data = (result as { data?: unknown } | undefined)?.data
  if (typeof data === "string") return data
  if (!data || typeof data !== "object") return ""
  const file = data as { type?: string; content?: unknown }
  if (file.type === "text" && typeof file.content === "string") return file.content
  return ""
}

function reportLanguage(path: string) {
  const lower = path.toLowerCase()
  if (lower.endsWith(".tsx")) return "TSX"
  if (lower.endsWith(".jsx")) return "JSX"
  if (lower.endsWith(".ts")) return "TypeScript"
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "JavaScript"
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "HTML"
  if (lower.endsWith(".css")) return "CSS"
  if (lower.endsWith(".json")) return "JSON"
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "Markdown"
  if (lower.endsWith(".py")) return "Python"
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "Shell"
  return "Other"
}

function reportFileBasename(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path
}

function looksLikeTextProjectFile(path: string) {
  if (path.includes("/node_modules/") || path.startsWith("node_modules/")) return false
  if (path.includes("/.git/") || path.startsWith(".git/")) return false
  if (path.includes("/dist/") || path.startsWith("dist/")) return false
  if (path.includes("/build/") || path.startsWith("build/")) return false
  if (path.includes("/.next/") || path.startsWith(".next/")) return false
  return /\.(tsx?|jsx?|html?|css|json|mdx?|py|sh|bash|zsh|yml|yaml|toml|env\.example)$/i.test(path)
}

function readPackageScripts(packageJson: string) {
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }
    return {
      scripts: Object.entries(parsed.scripts ?? {})
        .filter(([, value]) => typeof value === "string")
        .map(([name]) => `npm run ${name}`),
      dependencies: { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) },
    }
  } catch {
    return { scripts: [], dependencies: {} as Record<string, unknown> }
  }
}

function buildVectorLocalReport(files: VectorReportFile[], diffs: readonly RenderDiff[], modelLabel: string): VectorLocalReport {
  const fileByPath = new Map(files.map((file) => [file.path, file.content]))
  const languageMap = new Map<string, { files: number; lines: number }>()
  const problems: VectorReportProblem[] = []
  let lineCount = 0
  let charCount = 0

  for (const file of files) {
    const lines = file.content.split("\n").length
    lineCount += lines
    charCount += file.content.length
    const language = reportLanguage(file.path)
    const current = languageMap.get(language) ?? { files: 0, lines: 0 }
    current.files += 1
    current.lines += lines
    languageMap.set(language, current)

    for (const secret of detectSecrets(file.content)) {
      problems.push({ severity: "warning", path: file.path, message: `${secret} pattern found. Keep real credentials in environment variables.` })
    }

    if (file.path.endsWith(".json")) {
      try {
        JSON.parse(file.content)
      } catch {
        problems.push({ severity: "error", path: file.path, message: "Invalid JSON syntax." })
      }
    }

    if (/TODO|FIXME/i.test(file.content)) {
      problems.push({ severity: "info", path: file.path, message: "TODO/FIXME notes remain in this file." })
    }
  }

  const packageText = fileByPath.get("package.json") ?? ""
  const packageInfo = readPackageScripts(packageText)
  const deps = packageInfo.dependencies
  const frameworks = [
    deps.react ? "React" : "",
    deps.vue ? "Vue" : "",
    deps.svelte ? "Svelte" : "",
    deps.next ? "Next.js" : "",
    deps.vite || packageText.includes("\"vite\"") ? "Vite" : "",
    deps.tailwindcss ? "Tailwind CSS" : "",
    files.some((file) => file.path.endsWith(".py")) ? "Python" : "",
  ].filter(Boolean)

  const entrypoints = [
    "index.html",
    "src/main.tsx",
    "src/main.jsx",
    "src/App.tsx",
    "src/App.jsx",
    "app/page.tsx",
    "pages/index.tsx",
    "main.py",
  ].filter((path) => fileByPath.has(path))

  const runCommands = packageInfo.scripts.length
    ? packageInfo.scripts.slice(0, 8)
    : files.some((file) => file.path.endsWith(".py"))
      ? ["python main.py"]
      : entrypoints.includes("index.html")
        ? ["Open index.html in Preview"]
        : []

  const htmlFiles = files.filter((file) => isHtmlPath(file.path))
  for (const htmlFile of htmlFiles) {
    const refs = previewAssetRefs(htmlFile.path, htmlFile.content)
    for (const ref of refs) {
      if (!fileByPath.has(ref)) problems.push({ severity: "error", path: htmlFile.path, message: `Preview asset is missing: ${ref}` })
    }
  }

  const previewErrors = problems.filter((problem) => problem.severity === "error")
  const preview = htmlFiles.length
    ? previewErrors.length
      ? {
          status: "warning" as const,
          title: "Preview may load with missing assets",
          details: previewErrors.slice(0, 4).map((problem) => `${problem.path}: ${problem.message}`),
        }
      : {
          status: "ready" as const,
          title: "Preview has a reachable HTML entry",
          details: [`Vector found ${htmlFiles[0]?.path}.`, ...runCommands.slice(0, 2)],
        }
    : {
        status: "blocked" as const,
        title: "No previewable HTML entry found",
        details: ["Open Codespace and create or select an HTML/front-end entry file before using Preview."],
      }

  const estimatedTokens = Math.ceil(charCount / 4)
  const risk = estimatedTokens > 80_000 ? "High" : estimatedTokens > 24_000 ? "Medium" : "Low"
  const costGuidance = [
    risk === "High"
      ? "Use a frontier model and ask Vector to focus on specific files before broad refactors."
      : risk === "Medium"
        ? "This project is moderate size. File selection and clear task scope will keep BYOK cost sane."
        : "This is a small context pack. Most capable coding models should handle focused tasks cheaply.",
    `Current model: ${modelLabel || "not selected"}.`,
    diffs.length ? `${diffs.length} pending review file${diffs.length === 1 ? "" : "s"} should be inspected before another large edit.` : "No pending review diffs detected.",
  ]

  const importantFiles = [
    ...entrypoints,
    ...files
      .filter((file) => ["package.json", "vite.config.ts", "vite.config.js", "tailwind.config.js", "tsconfig.json"].includes(file.path))
      .map((file) => file.path),
    ...diffs.map((diff) => diff.file),
  ]
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 10)

  return {
    scannedAt: Date.now(),
    fileCount: files.length,
    lineCount,
    charCount,
    languageRows: [...languageMap.entries()]
      .map(([label, value]) => ({ label, ...value }))
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 8),
    entrypoints,
    frameworks: frameworks.length ? frameworks : ["Plain web / unknown stack"],
    runCommands,
    problems: problems.slice(0, 24),
    preview,
    cost: {
      estimatedTokens,
      risk,
      guidance: costGuidance,
    },
    memory: {
      summary: `${files.length} scanned text file${files.length === 1 ? "" : "s"}, ${lineCount.toLocaleString()} lines, ${frameworks.join(" + ") || "unknown stack"}.`,
      importantFiles,
      nextSteps: [
        preview.status === "blocked" ? "Create or select a previewable app entry." : "Open Preview and verify the main screen renders.",
        problems.some((problem) => problem.severity === "error") ? "Fix blocking syntax/missing-asset errors first." : "Keep changes small and reviewable through Change Queue.",
        "Create a checkpoint before accepting broad AI edits.",
      ],
    },
    promptGuard: {
      verdict: risk === "High" ? "Ask narrower prompts." : "Prompt size is manageable.",
      suggestions: [
        "Name the exact behavior you want changed.",
        "Mention the target screen/file when you know it.",
        "Paste the runtime error or screenshot details for debugging tasks.",
        risk === "High" ? "Avoid “rewrite the whole app”; ask for one feature or one bug at a time." : "Ask for a plan first when the edit touches multiple files.",
      ],
    },
    demoChecklist: [
      "Open the project in Vector Agent.",
      "Run one focused edit and wait for reviewable changes.",
      "Open Code Archaeology to inspect changed files and checkpoint docs.",
      preview.status === "ready" ? "Open Preview and show the rendered app." : "Fix preview blockers before demoing.",
      "Restore a checkpoint if the edit is not trustworthy.",
    ],
  }
}

function splitPatchLines(value: string) {
  if (!value) return []
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value
  return normalized.split("\n")
}

function analyzeCodespaceProblems(path: string | undefined, text: string): CodespaceProblem[] {
  const problems: CodespaceProblem[] = []
  if (!path) return problems

  const lines = text.split("\n")
  const stack: { char: string; line: number }[] = []
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" }
  const closing = new Set(Object.values(pairs))

  for (const [index, line] of lines.entries()) {
    const number = index + 1
    if (/\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"']{8,}/i.test(line)) {
      problems.push({
        severity: "error",
        line: number,
        message: "Possible hardcoded secret. Move credentials into environment variables or Vector settings.",
      })
    }
    if (/\bconsole\.log\s*\(/.test(line)) {
      problems.push({
        severity: "warning",
        line: number,
        message: "Debug console output detected. Remove it before shipping if it is not intentional.",
      })
    }
    if (/\bTODO\b|\bFIXME\b/i.test(line)) {
      problems.push({
        severity: "info",
        line: number,
        message: "Follow-up marker found.",
      })
    }

    for (const char of line) {
      if (pairs[char]) stack.push({ char, line: number })
      if (!closing.has(char)) continue
      const last = stack.at(-1)
      if (!last) continue
      if (pairs[last.char] === char) stack.pop()
    }
  }

  const lastOpen = stack.at(-1)
  if (lastOpen && /\.(js|jsx|ts|tsx|css|html)$/i.test(path)) {
    problems.push({
      severity: "warning",
      line: lastOpen.line,
      message: `Possible unmatched "${lastOpen.char}".`,
    })
  }

  if (/\.html?$/i.test(path)) {
    const html = text.toLowerCase()
    if (html.includes("<script") && !html.includes("</script>")) {
      problems.push({ severity: "error", line: 1, message: "HTML contains an opening script tag without a close tag." })
    }
    if (html.includes("<style") && !html.includes("</style>")) {
      problems.push({ severity: "error", line: 1, message: "HTML contains an opening style tag without a close tag." })
    }
  }

  return problems
}

const SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "Hardcoded credential", pattern: /\b(?:api[_-]?key|secret|password|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i },
]

function detectSecrets(text: string) {
  return SECRET_PATTERNS.filter((item) => item.pattern.test(text)).map((item) => item.label)
}

function loadCodespaceCheckpoints(): CodespaceCheckpoint[] {
  try {
    const raw = localStorage.getItem(CODESPACE_CHECKPOINTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function formatCheckpointTime(value: number) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function createAiCheckpointDocumentation(files: string[]) {
  const fileList = files.length ? files.join(", ") : "the current workspace"
  const scope =
    files.length === 1
      ? "a focused one-file edit"
      : files.length <= 4
        ? "a contained multi-file edit"
        : "a broad workspace edit that deserves careful review"
  return [
    `Vector captured this checkpoint immediately after the AI produced ${scope} across ${fileList}.`,
    "Review the changed files before applying more work. Restore this checkpoint if a later prompt regresses behavior, deletes important code, or moves the project away from the intended direction.",
  ].join(" ")
}

function estimateDiffRisk(diff: RenderDiff): "Low" | "Medium" | "High" {
  const additions = diff.additions ?? 0
  const deletions = diff.deletions ?? 0
  const touched = additions + deletions
  if (diff.status === "deleted" || deletions > 200 || touched > 500) return "High"
  if (diff.status === "added" || deletions > 40 || touched > 120) return "Medium"
  return "Low"
}

function diffActionLabel(diff: RenderDiff) {
  if (diff.status === "added") return "Created file"
  if (diff.status === "deleted") return "Deleted file"
  return "Edited file"
}

function loadAiChangeCheckpoints(session: string): AiChangeCheckpoint[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_CHANGE_CHECKPOINTS_KEY) ?? "[]") as AiChangeCheckpoint[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item) => item && item.session === session)
      .sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

function fileLanguage(path: string | undefined) {
  if (!path) return "text"
  const ext = path.split(".").pop()?.toLowerCase()
  if (!ext) return "text"
  const map: Record<string, string> = {
    js: "JavaScript",
    jsx: "React JSX",
    ts: "TypeScript",
    tsx: "React TSX",
    css: "CSS",
    html: "HTML",
    json: "JSON",
    md: "Markdown",
    py: "Python",
    java: "Java",
    go: "Go",
    rs: "Rust",
    rb: "Ruby",
    php: "PHP",
    swift: "Swift",
    kt: "Kotlin",
    sql: "SQL",
    yaml: "YAML",
    yml: "YAML",
  }
  return map[ext] ?? ext.toUpperCase()
}

function fileBasename(path: string | undefined) {
  if (!path) return "Untitled"
  return path.split("/").at(-1) || path
}

function fileBadge(path: string | undefined) {
  const ext = path?.split(".").pop()?.toLowerCase()
  if (!ext) return { label: "TXT", color: "text-slate-300", ring: "border-slate-400/25 bg-slate-500/10" }
  if (ext === "html" || ext === "htm") return { label: "HTML", color: "text-violet-300", ring: "border-violet-400/25 bg-violet-500/10" }
  if (ext === "css") return { label: "CSS", color: "text-pink-300", ring: "border-pink-400/25 bg-pink-500/10" }
  if (ext === "js" || ext === "jsx") return { label: ext.toUpperCase(), color: "text-yellow-300", ring: "border-yellow-400/25 bg-yellow-500/10" }
  if (ext === "ts" || ext === "tsx") return { label: ext.toUpperCase(), color: "text-sky-300", ring: "border-sky-400/25 bg-sky-500/10" }
  if (ext === "json") return { label: "JSON", color: "text-emerald-300", ring: "border-emerald-400/25 bg-emerald-500/10" }
  if (ext === "md") return { label: "MD", color: "text-zinc-300", ring: "border-zinc-400/25 bg-zinc-500/10" }
  return { label: ext.toUpperCase(), color: "text-slate-300", ring: "border-slate-400/25 bg-slate-500/10" }
}

const vectorCodeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "#c678dd", fontWeight: "600" },
  { tag: [t.atom, t.bool, t.null], color: "#d19a66" },
  { tag: [t.number, t.integer, t.float], color: "#d19a66" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#98c379" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6f7a8f", fontStyle: "italic" },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], color: "#61afef" },
  { tag: [t.variableName, t.self, t.propertyName], color: "#e5c07b" },
  { tag: [t.typeName, t.className], color: "#56b6c2" },
  { tag: [t.tagName, t.angleBracket], color: "#e06c75" },
  { tag: [t.attributeName], color: "#d19a66" },
  { tag: [t.heading, t.strong], color: "#e5c07b", fontWeight: "700" },
  { tag: [t.link], color: "#61afef", textDecoration: "underline" },
  { tag: [t.invalid], color: "#ff7b72", textDecoration: "wavy underline" },
])

const vectorCodeTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "#e2e0e8",
      backgroundColor: "#141318",
      fontSize: "var(--vector-editor-font-size, 13px)",
    },
    ".cm-scroller": {
      fontFamily:
        'var(--vector-editor-font-family, "JetBrainsMono Nerd Font Mono", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace)',
      lineHeight: "var(--vector-editor-line-height, 1.55)",
      overflow: "auto",
    },
    ".cm-content": {
      minHeight: "100%",
      padding: "8px 0 40px 0",
      caretColor: "#c4b5fd",
    },
    ".cm-line": {
      padding: "0 12px",
    },
    ".cm-gutters": {
      backgroundColor: "#17161c",
      color: "#7c7889",
      borderRight: "1px solid rgba(255, 255, 255, 0.06)",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "36px",
      padding: "0 8px 0 6px",
    },
    ".cm-foldGutter .cm-gutterElement": {
      padding: "0 7px 0 2px",
      color: "#6e6a7b",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(155, 108, 255, 0.07)",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(155, 108, 255, 0.1)",
      color: "#c9c4d6",
    },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "rgba(139, 92, 246, 0.34) !important",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "rgba(139, 92, 246, 0.26)",
      outline: "1px solid rgba(196, 181, 253, 0.65)",
      borderRadius: "3px",
    },
    ".cm-tooltip": {
      border: "1px solid rgba(255, 255, 255, 0.1)",
      backgroundColor: "#1b1a21",
      color: "#e5e2ec",
      borderRadius: "10px",
      boxShadow: "0 18px 45px rgba(0,0,0,0.38)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete ul": {
      fontFamily:
        'var(--vector-editor-font-family, "JetBrainsMono Nerd Font Mono", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace)',
      padding: "6px",
    },
    ".cm-tooltip-autocomplete ul li": {
      borderRadius: "7px",
      padding: "4px 10px",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "rgba(124, 58, 237, 0.28)",
      color: "#ffffff",
    },
    ".cm-completionMatchedText": {
      color: "#c4b5fd",
      textDecoration: "none",
      fontWeight: "700",
    },
    ".cm-cursor": {
      borderLeftColor: "#c4b5fd",
    },
    ".cm-indent-guide": {
      borderLeft: "1px solid rgba(255, 255, 255, 0.08)",
    },
    ".cm-scroller::-webkit-scrollbar": {
      width: "12px",
      height: "12px",
    },
    ".cm-scroller::-webkit-scrollbar-track": {
      background: "#17161c",
    },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      background: "#3a3742",
      border: "3px solid #17161c",
      borderRadius: "999px",
    },
    ".cm-scroller::-webkit-scrollbar-thumb:hover": {
      background: "#4c4857",
    },
  },
  { dark: true },
)

const commonKeywordCompletions: Completion[] = [
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "else",
  "export",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "let",
  "new",
  "null",
  "return",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "undefined",
  "var",
  "while",
].map((label) => ({ label, type: "keyword", detail: "keyword", boost: 55 }))

const javascriptSnippets: Completion[] = [
  snippetCompletion("function ${name}(${params}) {\n\t${}\n}", {
    label: "function",
    type: "snippet",
    detail: "function declaration",
    boost: 90,
  }),
  snippetCompletion("const ${name} = (${params}) => {\n\t${}\n}", {
    label: "arrow function",
    type: "snippet",
    detail: "const arrow function",
    boost: 86,
  }),
  snippetCompletion("import ${name} from \"${module}\"", {
    label: "import",
    type: "snippet",
    detail: "ES module import",
    boost: 84,
  }),
  snippetCompletion("if (${condition}) {\n\t${}\n}", {
    label: "if",
    type: "snippet",
    detail: "if statement",
    boost: 82,
  }),
  snippetCompletion("for (const ${item} of ${items}) {\n\t${}\n}", {
    label: "for of",
    type: "snippet",
    detail: "for...of loop",
    boost: 78,
  }),
  snippetCompletion("export default function ${Component}() {\n\treturn (\n\t\t<div>${}</div>\n\t)\n}", {
    label: "React component",
    type: "snippet",
    detail: "functional component",
    boost: 88,
  }),
]

const pythonCompletions: Completion[] = [
  "and",
  "as",
  "class",
  "def",
  "elif",
  "else",
  "False",
  "for",
  "from",
  "if",
  "import",
  "in",
  "None",
  "not",
  "or",
  "return",
  "True",
  "try",
  "while",
  "with",
].map((label) => ({ label, type: "keyword", detail: "Python keyword", boost: 58 }))

const pythonSnippets: Completion[] = [
  snippetCompletion("def ${name}(${params}):\n\t${}", { label: "def", type: "snippet", detail: "Python function", boost: 90 }),
  snippetCompletion("class ${Name}:\n\tdef __init__(self):\n\t\t${}", { label: "class", type: "snippet", detail: "Python class", boost: 82 }),
  snippetCompletion("if ${condition}:\n\t${}", { label: "if", type: "snippet", detail: "Python if block", boost: 80 }),
]

const htmlCompletions: Completion[] = [
  "a",
  "article",
  "body",
  "button",
  "div",
  "footer",
  "form",
  "h1",
  "h2",
  "head",
  "header",
  "html",
  "img",
  "input",
  "label",
  "li",
  "main",
  "meta",
  "nav",
  "p",
  "script",
  "section",
  "span",
  "style",
  "ul",
].map((label) => ({ label, type: "keyword", detail: "HTML tag", boost: 62 }))

const htmlSnippets: Completion[] = [
  snippetCompletion("<${tag}>${}</${tag}>", { label: "tag", type: "snippet", detail: "HTML element", boost: 86 }),
  snippetCompletion("<div class=\"${className}\">\n\t${}\n</div>", { label: "div", type: "snippet", detail: "div with class", boost: 84 }),
  snippetCompletion("<button type=\"button\">${label}</button>", { label: "button", type: "snippet", detail: "button element", boost: 76 }),
]

const cssCompletions: Completion[] = [
  "align-items",
  "background",
  "background-color",
  "border",
  "border-radius",
  "box-shadow",
  "color",
  "display",
  "flex",
  "font-family",
  "font-size",
  "gap",
  "grid",
  "height",
  "justify-content",
  "margin",
  "max-width",
  "min-height",
  "padding",
  "position",
  "transition",
  "width",
].map((label) => ({ label, type: "property", detail: "CSS property", boost: 60 }))

const cssSnippets: Completion[] = [
  snippetCompletion("display: flex;\nalign-items: ${center};\njustify-content: ${center};", {
    label: "flex center",
    type: "snippet",
    detail: "center with flexbox",
    boost: 82,
  }),
  snippetCompletion("grid-template-columns: repeat(${count}, minmax(0, 1fr));", {
    label: "grid columns",
    type: "snippet",
    detail: "responsive grid columns",
    boost: 78,
  }),
]

const jsonCompletions: Completion[] = ["true", "false", "null"].map((label) => ({
  label,
  type: "constant",
  detail: "JSON value",
  boost: 70,
}))

const shellCompletions: Completion[] = [
  "cat",
  "cd",
  "chmod",
  "cp",
  "done",
  "echo",
  "elif",
  "else",
  "export",
  "fi",
  "for",
  "grep",
  "if",
  "mkdir",
  "npm",
  "python",
  "rm",
  "then",
].map((label) => ({ label, type: "keyword", detail: "shell", boost: 54 }))

function fileExtension(path: string | undefined) {
  if (!path) return ""
  const name = fileBasename(path).toLowerCase()
  if (name === "dockerfile") return "dockerfile"
  if (name.startsWith(".env")) return "env"
  return path.split(".").pop()?.toLowerCase() ?? ""
}

function looksLikeHtml(text: string) {
  const value = text.trimStart().toLowerCase()
  return value.startsWith("<!doctype") || value.startsWith("<html") || /<([a-z][\w:-]*)(\s|>|\/>)/i.test(value)
}

function inferExtensionFromContent(text: string) {
  const value = text.trim()
  if (!value) return ""
  if (looksLikeHtml(value)) return "html"
  if (/^#!.*\b(bash|sh|zsh)\b/.test(value) || /\b(npm|pnpm|bun|python|pip|echo|export)\b/.test(value.split("\n").slice(0, 8).join("\n"))) return "sh"
  if (/^\s*[{[]/.test(value)) {
    try {
      JSON.parse(value)
      return "json"
    } catch {
      // Keep looking; JavaScript and CSS can also start with braces.
    }
  }
  if (/(^|\n)\s*(def|class|import|from)\s+[\w*.]+/m.test(value) || /(^|\n)\s*print\(/m.test(value)) return "py"
  if (/(^|\n)\s*(@import|:root|body\s*\{|[.#][\w-]+\s*\{|[\w-]+\s*:\s*[^;\n]+;)/m.test(value)) return "css"
  if (/(^|\n)\s*(import|export|const|let|var|function|class|interface|type)\s+/m.test(value)) {
    if (/(^|\n)\s*(interface|type)\s+\w+\s*=|:\s*React\.|<\w+[\s>]/m.test(value)) return "tsx"
    return "js"
  }
  return ""
}

function languageExtension(path: string | undefined, content = "") {
  const ext = fileExtension(path)
  if (!ext || ext === "txt" || ext === "text") return inferExtensionFromContent(content) || ext
  return ext
}

function codeMirrorLanguage(path: string, content = ""): Extension {
  const ext = languageExtension(path, content)
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return javascript({ jsx: true })
  if (ext === "ts") return javascript({ typescript: true })
  if (ext === "tsx") return javascript({ jsx: true, typescript: true })
  if (ext === "html" || ext === "htm" || ext === "xml" || ext === "vue" || ext === "svelte") return html()
  if (ext === "css" || ext === "scss" || ext === "less") return css()
  if (ext === "json" || ext === "jsonc") return json()
  if (ext === "py" || ext === "pyw") return python()
  if (ext === "md" || ext === "markdown") return markdown()
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "env") return StreamLanguage.define(shell)
  return []
}

function languageCompletions(path: string, content = "") {
  const ext = languageExtension(path, content)
  if (ext === "py" || ext === "pyw") return [...pythonCompletions, ...pythonSnippets]
  if (ext === "html" || ext === "htm" || ext === "xml" || ext === "vue" || ext === "svelte") {
    return [...htmlCompletions, ...htmlSnippets, ...commonKeywordCompletions]
  }
  if (ext === "css" || ext === "scss" || ext === "less") return [...cssCompletions, ...cssSnippets]
  if (ext === "json" || ext === "jsonc") return jsonCompletions
  if (ext === "sh" || ext === "bash" || ext === "zsh" || ext === "env") return [...shellCompletions]
  if (ext === "md" || ext === "markdown") return [...commonKeywordCompletions]
  return [...commonKeywordCompletions, ...javascriptSnippets]
}

function localWordCompletions(text: string): Completion[] {
  const seen = new Set<string>()
  const out: Completion[] = []
  const matches = text.matchAll(/\b[A-Za-z_$][\w$-]{2,}\b/g)
  for (const match of matches) {
    const label = match[0]
    if (seen.has(label)) continue
    seen.add(label)
    out.push({ label, type: /^[A-Z]/.test(label) ? "class" : "variable", detail: "current file", boost: 18 })
    if (out.length >= 650) break
  }
  return out
}

function vectorCompletionSource(path: string) {
  return (context: CompletionContext) => {
    const word = context.matchBefore(/[A-Za-z_$][\w$-]*/)
    if (!word || (!context.explicit && word.from === word.to)) return null
    const text = context.state.doc.toString()
    const options = [...languageCompletions(path, text), ...localWordCompletions(text)]
    return {
      from: word.from,
      options,
      validFor: /^[A-Za-z_$][\w$-]*$/,
    }
  }
}

function VectorCodeEditor(props: { path: string; value: string; onChange: (next: string) => void }) {
  const editorSettings = useSettings().editor
  let mount: HTMLDivElement | undefined
  let view: EditorView | undefined
  let internalUpdate = false

  const destroy = () => {
    view?.destroy()
    view = undefined
  }

  createEffect(
    on(
      () =>
        [
          props.path,
          editorSettings.wordWrap(),
          editorSettings.showLineNumbers(),
          editorSettings.highlightActiveLine(),
          editorSettings.renderWhitespace(),
        ] as const,
      ([path, wordWrap, showLineNumbers, activeLine, whitespace]) => {
        if (!mount) return
        destroy()
        mount.textContent = ""
        const doc = untrack(() => props.value ?? "")
        view = new EditorView({
          parent: mount,
          state: EditorState.create({
            doc,
            extensions: [
              ...(showLineNumbers ? [codeMirrorLineNumbers()] : []),
              foldGutter(),
              ...(activeLine ? [highlightActiveLineGutter()] : []),
              history(),
              drawSelection(),
              dropCursor(),
              EditorState.allowMultipleSelections.of(true),
              indentOnInput(),
              bracketMatching(),
              closeBrackets(),
              rectangularSelection(),
              crosshairCursor(),
              ...(activeLine ? [highlightActiveLine()] : []),
              ...(wordWrap ? [EditorView.lineWrapping] : []),
              ...(whitespace ? [highlightWhitespace()] : []),
              highlightSelectionMatches(),
              indentUnit.of("  "),
              codeMirrorLanguage(path, doc),
              syntaxHighlighting(vectorCodeHighlight, { fallback: true }),
              vectorCodeTheme,
              autocompletion({
                activateOnTyping: true,
                defaultKeymap: true,
                override: [vectorCompletionSource(path)],
              }),
              keymap.of([
                indentWithTab,
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...historyKeymap,
                ...completionKeymap,
              ]),
              EditorView.updateListener.of((update) => {
                if (!update.docChanged) return
                internalUpdate = true
                props.onChange(update.state.doc.toString())
              }),
            ],
          }),
        })
      },
      { defer: false },
    ),
  )

  createEffect(() => {
    const next = props.value ?? ""
    if (!view) return
    const current = view.state.doc.toString()
    if (internalUpdate) internalUpdate = false
    if (next === current) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } })
  })

  onCleanup(destroy)

  return <div ref={mount} class="h-full w-full overflow-hidden bg-[#131217]" />
}

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

function compactTask(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 180)
}

function previewDiffLines(before: string, after: string) {
  const oldLines = splitPatchLines(before)
  const newLines = splitPatchLines(after)
  return newLines.map((line, index) => ({
    number: index + 1,
    line,
    added: oldLines[index] !== line,
  }))
}

function extractModelText(value: unknown, depth = 0): string {
  if (!value || depth > 5) return ""
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) return value.map((item) => extractModelText(item, depth + 1)).filter(Boolean).join("\n\n").trim()
  if (typeof value !== "object") return ""

  const candidate = value as Record<string, unknown>
  if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text.trim()

  for (const key of ["text", "content", "message", "output", "output_text", "response"]) {
    const next = candidate[key]
    if (typeof next === "string" && next.trim()) return next.trim()
  }

  for (const key of ["parts", "content", "messages", "data", "message", "output"]) {
    const next = candidate[key]
    const text = extractModelText(next, depth + 1)
    if (text) return text
  }

  return ""
}

function extractFirstCodeBlock(text: string) {
  const match = text.match(/```[^\n`]*\n([\s\S]*?)```/)
  return match?.[1]?.replace(/\s+$/, "")
}

function extractGeneratedCodeProposal(text: string, current: string) {
  const block = extractFirstCodeBlock(text)
  if (block?.trim()) return block.replace(/\s+$/, "")

  const trimmed = text.trim()
  if (!trimmed) return
  const looksLikeCode = [
    /^\s*<!doctype\s+html/i,
    /^\s*<html[\s>]/i,
    /^\s*(import|export|const|let|var|function|class|def|from|#include)\b/m,
    /^\s*(body|html|main|\.|#)[\w\s.#:[\]-]*\{/m,
    /^\s*[\[{][\s\S]*[\]}]\s*$/m,
    /<\/[a-z][\w-]*>/i,
  ].some((pattern) => pattern.test(trimmed))

  if (!looksLikeCode) return
  if (current.length > 800 && trimmed.length < current.length * 0.35) return
  return trimmed.replace(/\s+$/, "")
}

function isHtmlPath(path: string | undefined) {
  return Boolean(path?.match(/\.html?$/i))
}

function pathDirname(path: string) {
  const index = path.lastIndexOf("/")
  return index === -1 ? "" : path.slice(0, index)
}

function previewAssetPath(htmlPath: string, asset: string) {
  const clean = asset.split(/[?#]/)[0]?.trim()
  if (!clean || /^(https?:|data:|blob:|\/\/)/i.test(clean)) return
  if (clean.startsWith("/")) {
    const stripped = clean.replace(/^\/+/, "")
    const previewRoot = pathDirname(htmlPath).split("/")[0]
    if ((previewRoot === "dist" || previewRoot === "build") && stripped) return `${previewRoot}/${stripped}`
    return stripped
  }
  const dir = pathDirname(htmlPath)
  const parts = `${dir ? `${dir}/` : ""}${clean}`.split("/")
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out.join("/")
}

function looksLikeBundledAppHtml(html: string) {
  return (
    /<script\b[^>]*type=(["'])module\1[^>]*src=/i.test(html) ||
    /\/src\/[^"']+\.(?:m?js|jsx|ts|tsx)(?:\?[^"']*)?/i.test(html)
  )
}

function looksLikeViteProject(packageJson: string) {
  return /"vite"\s*:/.test(packageJson) || /"@vitejs\//.test(packageJson)
}

function isBuiltPreviewPath(path: string) {
  return path === "dist/index.html" || path === "build/index.html"
}

function previewAssetRefs(htmlPath: string, html: string) {
  const out = new Set<string>()
  html.replace(/<link\b[^>]*?href=(["'])([^"']+\.css(?:\?[^"']*)?)\1[^>]*?>/gi, (_match, _quote, href) => {
    const path = previewAssetPath(htmlPath, href)
    if (path) out.add(path)
    return ""
  })
  html.replace(/<script\b[^>]*?src=(["'])([^"']+\.(?:m?js|jsx|ts|tsx)(?:\?[^"']*)?)\1[^>]*?>\s*<\/script>/gi, (_match, _quote, src) => {
    const path = previewAssetPath(htmlPath, src)
    if (path) out.add(path)
    return ""
  })
  return [...out]
}

function inlinePreviewAssets(htmlPath: string, html: string, readFile: (path: string) => string) {
  return html
    .replace(/<link\b([^>]*?)href=(["'])([^"']+\.css(?:\?[^"']*)?)\2([^>]*?)>/gi, (match, before, _quote, href, after) => {
      const path = previewAssetPath(htmlPath, href)
      const content = path ? readFile(path) : ""
      if (!content.trim()) return match
      return `<style data-vector-preview="${path}"${before.includes("media=") || after.includes("media=") ? "" : ""}>\n${content}\n</style>`
    })
    .replace(/<script\b([^>]*?)src=(["'])([^"']+\.(?:m?js|jsx|ts|tsx)(?:\?[^"']*)?)\2([^>]*?)>\s*<\/script>/gi, (match, before, _quote, src, after) => {
      const path = previewAssetPath(htmlPath, src)
      const content = path ? readFile(path) : ""
      if (!content.trim()) return match
      const attrs = `${before} ${after}`
      const moduleAttr = /\btype\s*=\s*(["'])module\1/i.test(attrs) ? ` type="module"` : ""
      return `<script${moduleAttr} data-vector-preview="${path}">\n${content.replace(/<\/script/gi, "<\\/script")}\n</script>`
    })
}

function injectPreviewRuntime(html: string) {
  const guard = `
<script data-vector-preview-runtime>
(() => {
  const showError = (message) => {
    let node = document.getElementById("vector-preview-error");
    if (!node) {
      node = document.createElement("div");
      node.id = "vector-preview-error";
      node.style.cssText = [
        "position:fixed",
        "left:16px",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "padding:14px 16px",
        "border-radius:14px",
        "background:rgba(17,14,24,0.94)",
        "border:1px solid rgba(168,85,247,0.35)",
        "box-shadow:0 18px 50px rgba(0,0,0,0.35)",
        "color:#f6f2ff",
        "font:13px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        "white-space:pre-wrap",
      ].join(";");
      document.documentElement.appendChild(node);
    }
    node.textContent = "Vector Preview stopped because the app threw an error:\\n" + message;
  };
  window.addEventListener("error", (event) => {
    showError(event.message || "Unknown runtime error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    showError(reason && reason.message ? reason.message : String(reason || "Unhandled promise rejection"));
  });
  document.addEventListener("click", (event) => {
    const target = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!target) return;
    const href = target.getAttribute("href");
    if (!href || href.startsWith("#") || /^(https?:|mailto:|tel:|data:|blob:|\\/\\/)/i.test(href)) return;
    if (href.startsWith("/")) {
      event.preventDefault();
      try {
        history.pushState({}, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
      } catch {
        location.hash = href;
      }
    }
  }, true);
})();
</script>`
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${guard}\n</body>`)
  return `${html}\n${guard}`
}

function buildPreviewDocument(htmlPath: string, html: string, readFile: (path: string) => string) {
  return injectPreviewRuntime(inlinePreviewAssets(htmlPath, html, readFile))
}

function CodespaceWorkbench(props: {
  modified: () => readonly string[]
  kinds: () => ReadonlyMap<string, Kind>
  empty: () => JSX.Element
  diffs: () => readonly RenderDiff[]
  focusReviewDiff: (path: string) => void
  onClose: () => void
}) {
  const file = useFile()
  const sdk = useSDK()
  const local = useLocal()
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>()
  const [activeView, setActiveView] = createSignal<CodespaceView>("editor")
  const [toolsOpen, setToolsOpen] = createSignal(false)
  const [toolBrief, setToolBrief] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [openFiles, setOpenFiles] = createSignal<string[]>([])
  const [drafts, setDrafts] = createStore<Record<string, string>>({})
  const [checkpoints, setCheckpoints] = createSignal<CodespaceCheckpoint[]>(loadCodespaceCheckpoints())
  const [queuedChanges, setQueuedChanges] = createSignal<CodespaceQueuedChange[]>([])
  const [selectedQueueId, setSelectedQueueId] = createSignal<string | undefined>()
  const [coprogrammerMode, setCoprogrammerMode] = createSignal<"build" | "repair" | "refactor" | "learn">("build")
  const [coprogrammerRunning, setCoprogrammerRunning] = createSignal(false)
  const [coprogrammerDraft, setCoprogrammerDraft] = createSignal("")
  const [coprogrammerLog, setCoprogrammerLog] = createSignal<CodespaceAgentLog[]>([])
  const [architectInput, setArchitectInput] = createSignal("")
  const [architectRunning, setArchitectRunning] = createSignal(false)
  const [architectMessages, setArchitectMessages] = createSignal<CodespaceArchitectMessage[]>([
    {
      id: "architect-welcome",
      role: "assistant",
      content: "I can review architecture, explain files, plan safe changes, and help you decide what to build next. Ask me about the open file or project.",
      createdAt: Date.now(),
    },
  ])

  const state = createMemo(() => {
    const path = selectedPath()
    if (!path) return
    return file.get(path)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const draft = createMemo(() => {
    const path = selectedPath()
    if (!path) return ""
    return drafts[path] ?? contents()
  })
  const dirty = createMemo(() => {
    const path = selectedPath()
    if (!path) return false
    return draft() !== contents()
  })
  const problems = createMemo(() => analyzeCodespaceProblems(selectedPath(), draft()))
  const selectedCheckpoints = createMemo(() => checkpoints().filter((item) => item.path === selectedPath()))
  const lineCount = createMemo(() => draft().split("\n").length)
  const fileText = (path: string | undefined) => {
    if (!path) return ""
    return drafts[path] ?? file.get(path)?.content?.content ?? ""
  }
  const previewCandidates = createMemo(() => {
    const current = selectedPath()
    const candidates = new Set<string>()
    if (current) {
      candidates.add(current)
      const dir = pathDirname(current)
      candidates.add(dir ? `${dir}/index.html` : "index.html")
      candidates.add(dir ? `${dir}/index.htm` : "index.htm")
    }
    candidates.add("index.html")
    candidates.add("index.htm")
    candidates.add("dist/index.html")
    candidates.add("build/index.html")
    candidates.add("src/index.html")
    candidates.add("public/index.html")
    for (const path of openFiles()) candidates.add(path)
    for (const path of props.modified()) candidates.add(path)
    return [...candidates].filter((path) => isHtmlPath(path) || looksLikeHtml(fileText(path)))
  })
  const previewPath = createMemo(() => {
    const candidates = previewCandidates()
    const built = candidates.find((path) => isBuiltPreviewPath(path) && looksLikeHtml(fileText(path)))
    if (built) return built
    return candidates.find((path) => looksLikeHtml(fileText(path))) ?? candidates.find((path) => fileText(path).trim()) ?? candidates[0]
  })
  const previewDocument = createMemo(() => {
    const path = previewPath()
    const html = fileText(path)
    if (!path || !html.trim()) return ""
    return buildPreviewDocument(path, html, fileText)
  })
  const activeBadge = createMemo(() => fileBadge(selectedPath()))
  const breakpointCount = createMemo(() => problems().filter((problem) => problem.severity === "error").length)
  const activeModelLabel = createMemo(() => {
    const model = local.model.current()
    if (!model) return "No model selected"
    const variant = local.model.variant.current()
    return `${model.name}${variant ? ` · ${variant}` : ""}`
  })
  const selectedModelPayload = createMemo(() => {
    const model = local.model.current()
    if (!model) return
    return {
      providerID: model.provider.id,
      modelID: model.id,
    }
  })
  const activeVariant = createMemo(() => local.model.variant.current())
  const activeAgentName = createMemo(() => local.agent.current()?.name ?? "build")
  const selectedQueue = createMemo(() => {
    const id = selectedQueueId()
    return queuedChanges().find((item) => item.id === id) ?? queuedChanges()[0]
  })
  const queueCount = createMemo(() => queuedChanges().length + props.diffs().length)

  createEffect(() => {
    if (activeView() !== "preview") return
    const candidates = previewCandidates()
    const path = previewPath()
    const html = path ? fileText(path) : ""
    untrack(() => {
      void file.load("package.json").catch(() => {})
      for (const candidate of candidates) void file.load(candidate).catch(() => {})
      if (!path || !html.trim()) return
      for (const asset of previewAssetRefs(path, html)) void file.load(asset).catch(() => {})
    })
  })

  const invokeCodespaceModel = async (input: { title: string; system: string; prompt: string }) => {
    const model = selectedModelPayload()
    if (!model) {
      throw new Error("Select a model in Vector before using Codespace AI.")
    }

    const session = await sdk().client.session.create({
      directory: sdk().directory,
      title: input.title,
      agent: activeAgentName(),
      model: {
        providerID: model.providerID,
        id: model.modelID,
        variant: activeVariant(),
      },
      metadata: {
        source: "vector-codespace",
        engine: "opencode-compatible",
        hidden: true,
      },
    })
    const sessionID = session.data?.id
    if (!sessionID) throw new Error("Vector could not create a Codespace AI session.")
    const result = await sdk().client.session.prompt({
      sessionID,
      directory: sdk().directory,
      agent: activeAgentName(),
      model,
      variant: activeVariant(),
      system: input.system,
      tools: {
        bash: false,
        edit: false,
        patch: false,
        write: false,
      },
      parts: [{ type: "text", text: input.prompt }],
    })
    const text = extractModelText(result.data)
    if (!text) throw new Error("The selected model returned an empty response.")
    return text
  }

  const openFile = (path: string) => {
    setSelectedPath(path)
    setOpenFiles((items) => (items.includes(path) ? items : [...items, path]))
    setActiveView("editor")
    void file.load(path)
  }

  const closeFileTab = (path: string) => {
    setOpenFiles((items) => items.filter((item) => item !== path))
    if (selectedPath() !== path) return
    const next = openFiles().find((item) => item !== path)
    setSelectedPath(next)
    if (next) void file.load(next)
  }

  const createNewFile = () => {
    const path = globalThis.prompt?.("New file path", "")?.trim()
    if (!path) return
    setSelectedPath(path)
    setOpenFiles((items) => (items.includes(path) ? items : [...items, path]))
    setDrafts(path, "")
    setActiveView("editor")
  }

  const quickOpen = async () => {
    const query = globalThis.prompt?.("Quick open file", fileBasename(selectedPath()))?.trim()
    if (!query) return
    const results = await file.searchFilesAndDirectories(query)
    const target = results.find((item) => item && !item.endsWith("/")) ?? results[0]
    if (!target) {
      showToast({ title: "No file found", description: `Vector could not find a file matching "${query}".` })
      return
    }
    openFile(target)
  }

  const copyCurrentFile = async () => {
    const path = selectedPath()
    if (!path) return
    await navigator.clipboard.writeText(draft())
    showToast({ title: "Copied", description: `${path} copied to clipboard.` })
  }

  const exportCurrentFile = () => {
    const path = selectedPath()
    if (!path) return
    const blob = new Blob([draft()], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = fileBasename(path)
    link.click()
    URL.revokeObjectURL(url)
  }

  createEffect(() => {
    const path = selectedPath()
    if (!path) return
    if (!state()?.loaded) return
    if (drafts[path] !== undefined) return
    setDrafts(path, contents())
  })

  createEffect(() => {
    if (selectedPath()) return
    const first = props.modified()[0]
    if (!first) return
    openFile(first)
  })

  createEffect(() => {
    const first = queuedChanges()[0]
    if (!first) {
      setSelectedQueueId(undefined)
      return
    }
    if (!queuedChanges().some((item) => item.id === selectedQueueId())) setSelectedQueueId(first.id)
  })

  const persistCheckpoints = (next: CodespaceCheckpoint[]) => {
    setCheckpoints(next)
    localStorage.setItem(CODESPACE_CHECKPOINTS_KEY, JSON.stringify(next.slice(0, 80)))
  }

  const createCheckpoint = () => {
    const path = selectedPath()
    if (!path) {
      showToast({ title: "Open a file first", description: "Select a file before creating a Codespace checkpoint." })
      return
    }
    const next: CodespaceCheckpoint = {
      id: crypto.randomUUID?.() ?? `${Date.now()}`,
      path,
      title: `${path} checkpoint`,
      content: draft(),
      createdAt: Date.now(),
    }
    persistCheckpoints([next, ...checkpoints()])
    showToast({ title: "Checkpoint saved", description: `${path} can now be restored from Codespace history.` })
  }

  const restoreCheckpoint = (item: CodespaceCheckpoint) => {
    setSelectedPath(item.path)
    setDrafts(item.path, item.content)
    setActiveView("editor")
    showToast({ title: "Checkpoint restored", description: item.title })
  }

  const removeCheckpoint = (id: string) => {
    persistCheckpoints(checkpoints().filter((item) => item.id !== id))
  }

  const saveDraft = async (options?: { path?: string; content?: string; base?: string; loaded?: boolean; silent?: boolean }) => {
    const path = options?.path ?? selectedPath()
    if (!path) return
    const nextContent = options?.content ?? draft()
    const baseContent = options?.base ?? contents()
    const isLoaded = options?.loaded ?? Boolean(state()?.loaded)
    if (nextContent === baseContent) {
      if (!options?.silent) showToast({ title: "Already saved", description: "There are no local edits to apply." })
      return
    }

    setSaving(true)
    try {
      await sdk().client.file.write({ directory: sdk().directory, path, content: nextContent })
      if (selectedPath() === path) await file.load(path, { force: true })
      await file.tree.refresh("")
      setDrafts(path, nextContent)
      if (!options?.silent) showToast({ title: "Saved to workspace", description: `${path} was updated from Codespace.` })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not save edit",
        description: error instanceof Error && error.message ? error.message : "Vector could not apply this file patch.",
      })
    } finally {
      setSaving(false)
    }
  }

  let autosaveTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => [selectedPath(), draft(), contents(), Boolean(state()?.loaded)] as const,
      ([path, nextContent, baseContent, loaded]) => {
        if (!path || !loaded || nextContent === baseContent) return
        if (autosaveTimer) clearTimeout(autosaveTimer)
        autosaveTimer = setTimeout(() => {
          void saveDraft({ path, content: nextContent, base: baseContent, loaded, silent: true })
        }, 650)
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
  })

  const debugProblem = (problem: CodespaceProblem) => {
    const path = selectedPath()
    if (!path) return
    setToolBrief(`Debug ${path} line ${problem.line}: ${problem.message}`)
    setActiveView("debugger")
  }

  const runCoprogrammer = async () => {
    const path = selectedPath()
    const task = toolBrief().trim()
    if (!path) {
      showToast({ title: "Open a file first", description: "Co-Programmer needs an active file to anchor the edit." })
      return
    }
    if (!task) {
      showToast({ title: "Describe the task", description: "Tell Co-Programmer what to build, fix, or refactor." })
      return
    }

    setCoprogrammerRunning(true)
    setCoprogrammerDraft("")
    setCoprogrammerLog([
      { status: "done", label: "Indexed workspace", detail: `${props.modified().length || 1} file${props.modified().length === 1 ? "" : "s"} available for context` },
      { status: "info", label: "Selected target", detail: path },
      { status: "info", label: "Planning task", detail: compactTask(task) },
    ])

    try {
      const oldContent = draft()
      setCoprogrammerLog((items) => [
        ...items,
        { status: "info", label: "Calling Vector engine", detail: activeModelLabel() },
      ])
      const modelResponse = await invokeCodespaceModel({
        title: `Codespace Co-Programmer: ${fileBasename(path)}`,
        system: [
          "You are Vector Codespace Co-Programmer.",
          "You are running through Vector's OpenCode-compatible engine.",
          "You propose safe code edits for a separate Codespace editor.",
          "Do not run tools, do not mutate files, and do not answer conversationally.",
          "Return exactly one fenced code block containing the COMPLETE updated contents of the target file.",
          "Preserve unrelated code exactly. Never replace a large file with a tiny snippet.",
        ].join("\n"),
        prompt: [
          `Mode: ${coprogrammerMode()}`,
          `Task: ${task}`,
          `Target file: ${path}`,
          `Language: ${fileLanguage(path)}`,
          "",
          "Current complete file:",
          "```",
          oldContent,
          "```",
          "",
          "Return only the complete updated file in one fenced code block.",
        ].join("\n"),
      })
      const proposedContent = extractGeneratedCodeProposal(modelResponse, oldContent)
      if (!proposedContent) {
        throw new Error("The model did not return a complete fenced file. No change was queued.")
      }
      if (oldContent.length > 800 && proposedContent.length < oldContent.length * 0.35) {
        throw new Error("Vector blocked this proposal because it looks like an incomplete file replacement.")
      }
      const newContent = proposedContent.endsWith("\n") ? proposedContent : `${proposedContent}\n`
      const item: CodespaceQueuedChange = {
        id: makeId("queue"),
        path,
        name: fileBasename(path),
        oldContent,
        newContent,
        source: compactTask(task),
        createdAt: Date.now(),
      }

      createCheckpoint()
      setQueuedChanges((items) => [item, ...items])
      setSelectedQueueId(item.id)
      setCoprogrammerDraft(
        [
          `Plan for ${fileBasename(path)}`,
          "",
          `- Mode: ${coprogrammerMode()}`,
          `- Task: ${compactTask(task)}`,
          "- Preserved existing file content.",
          "- Staged a complete-file proposal in Change Queue.",
          "- Review the highlighted diff before applying it.",
        ].join("\n"),
      )
      setCoprogrammerLog((items) => [
        ...items,
        { status: "done", label: "Generated proposal", detail: "Complete file staged without overwriting the workspace." },
        { status: "done", label: "Queued for review", detail: "Open Change Queue to accept or reject it." },
      ])
      setActiveView("changes")
      showToast({ title: "Change queued", description: "Co-Programmer staged a reviewable edit in Vector Change Queue." })
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : "Vector could not generate a safe Codespace proposal."
      setCoprogrammerDraft(`Co-Programmer stopped before changing anything.\n\n${detail}`)
      setCoprogrammerLog((items) => [...items, { status: "error", label: "Stopped safely", detail }])
      showToast({
        variant: "error",
        title: "Co-Programmer stopped safely",
        description: detail,
      })
    } finally {
      setCoprogrammerRunning(false)
    }
  }

  const rejectQueuedChange = (id: string) => {
    setQueuedChanges((items) => items.filter((item) => item.id !== id))
    showToast({ title: "Change rejected", description: "The queued edit was removed without touching the file." })
  }

  const acceptQueuedChange = async (item: CodespaceQueuedChange) => {
    setSaving(true)
    try {
      await sdk().client.file.write({ directory: sdk().directory, path: item.path, content: item.newContent })
      setDrafts(item.path, item.newContent)
      setSelectedPath(item.path)
      await file.load(item.path, { force: true })
      await file.tree.refresh("")
      setQueuedChanges((items) => items.filter((candidate) => candidate.id !== item.id))
      setActiveView("editor")
      showToast({ title: "Change accepted", description: `${item.name} was applied to the workspace.` })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not apply queued change",
        description: error instanceof Error && error.message ? error.message : "Vector could not apply this queued edit.",
      })
    } finally {
      setSaving(false)
    }
  }

  const sendArchitectMessage = async () => {
    const text = architectInput().trim()
    if (!text) return
    const path = selectedPath()
    const userMessage: CodespaceArchitectMessage = {
      id: makeId("architect-user"),
      role: "user",
      content: text,
      createdAt: Date.now(),
    }
    setArchitectMessages((items) => [...items, userMessage])
    setArchitectInput("")
    setArchitectRunning(true)

    try {
      const issueSummary = problems().length
        ? `${problems().length} local issue${problems().length === 1 ? "" : "s"} detected, including: ${problems()[0]?.message}`
        : "No blocking local problems are currently detected."
      const modelResponse = await invokeCodespaceModel({
        title: `Codespace AI Architect: ${fileBasename(path) || "Workspace"}`,
        system: [
          "You are Vector AI Architect inside Codespace.",
          "You are running through Vector's OpenCode-compatible engine.",
          "You are a chatbot for architecture, review, explanation, planning, and debugging advice.",
          "Do not edit files. Do not produce a full replacement file unless the user explicitly asks for code.",
          "Be concise, professional, and practical. Refer to the open file and problems when useful.",
        ].join("\n"),
        prompt: [
          `User question: ${text}`,
          "",
          `Open file: ${path ?? "none selected"}`,
          `Language: ${fileLanguage(path)}`,
          `Lines: ${lineCount()}`,
          `Draft state: ${dirty() ? "unsaved local draft" : "synced"}`,
          `Problems: ${issueSummary}`,
          `Queued changes: ${queuedChanges().length}`,
          "",
          "Open file excerpt:",
          "```",
          draft().slice(0, 12_000),
          "```",
        ].join("\n"),
      })
      const answer: CodespaceArchitectMessage = {
        id: makeId("architect-assistant"),
        role: "assistant",
        content: modelResponse,
        createdAt: Date.now(),
      }
      setArchitectMessages((items) => [...items, answer])
    } catch (error) {
      const detail = error instanceof Error && error.message ? error.message : "AI Architect could not reach the selected model."
      setArchitectMessages((items) => [
        ...items,
        {
          id: makeId("architect-assistant"),
          role: "assistant",
          content: `I could not complete that review yet.\n\n${detail}`,
          createdAt: Date.now(),
        },
      ])
    } finally {
      setArchitectRunning(false)
    }
  }

  const openCodespaceTool = (mode: CodespaceToolView) => {
    setActiveView(mode)
    const labels: Record<CodespaceToolView, string> = {
      debugger: "AI Debugger",
      architect: "AI Architect",
      coprogrammer: "Co-Programmer",
    }
    showToast({
      title: `${labels[mode]} opened`,
      description: "This stays inside Codespace and will not rewrite another prompt box.",
    })
  }

  const toolTitle = (mode: CodespaceToolView) =>
    ({
      debugger: "AI Debugger",
      architect: "AI Architect",
      coprogrammer: "Co-Programmer",
    })[mode]

  const problemCounts = createMemo(() => ({
    errors: problems().filter((problem) => problem.severity === "error").length,
    warnings: problems().filter((problem) => problem.severity === "warning").length,
    info: problems().filter((problem) => problem.severity === "info").length,
  }))

  return (
    <div class="h-full min-h-0 flex flex-col overflow-hidden bg-[#0d0a12] text-[#e9e4f5]">
      <header class="h-12 shrink-0 border-b border-[#2b2438] bg-[#141318]/95">
        <div class="h-full flex items-center gap-2 px-3">
          <div class="flex min-w-[86px] items-center gap-2.5">
            <button class="rounded-lg px-1.5 text-[#8c819d] transition duration-200 ease-out hover:bg-white/5 hover:text-white" aria-label="Back to Vector Agent" onClick={props.onClose}>
              ‹
            </button>
            <img src="/vector-logo.png" alt="" class="size-7 rounded-lg shadow-[0_0_18px_rgba(139,92,246,0.35)]" draggable={false} />
          </div>

          <nav class="relative mx-auto flex h-10 items-center overflow-visible rounded-2xl border border-[#352845] bg-[#1d1728] p-1 shadow-[0_12px_28px_rgba(0,0,0,0.28)]">
            <button
              class="h-8 rounded-xl px-3 text-12-medium transition duration-200 ease-out"
              classList={{
                "bg-[#5d32a8] text-white shadow-[0_0_18px_rgba(139,92,246,0.35)]": activeView() === "editor",
                "text-[#9d91af] hover:bg-white/5 hover:text-white": activeView() !== "editor",
              }}
              onClick={() => setActiveView("editor")}
            >
              ‹/› Editor
            </button>
            <button
              class="h-8 rounded-xl px-3 text-12-medium transition duration-200 ease-out"
              classList={{
                "bg-[#5d32a8] text-white": activeView() === "preview",
                "text-[#9d91af] hover:bg-white/5 hover:text-white": activeView() !== "preview",
              }}
              onClick={() => setActiveView("preview")}
            >
              ◉ Preview
            </button>
            <button
              class="h-8 rounded-xl px-3 text-12-medium text-[#9d91af] transition duration-200 ease-out hover:bg-white/5 hover:text-white"
              onClick={() => openCodespaceTool("coprogrammer")}
            >
              ⟡ Co-Programmer
            </button>
            <button
              class="h-8 rounded-xl px-3 text-12-medium text-[#9d91af] transition duration-200 ease-out hover:bg-white/5 hover:text-white"
              onClick={() => openCodespaceTool("architect")}
            >
              ✧ AI Architect
            </button>
            <button
              class="h-8 rounded-xl px-3 text-12-medium transition duration-200 ease-out"
              classList={{
                "bg-[#5d32a8] text-white": ["problems", "changes", "history"].includes(activeView()),
                "text-[#9d91af] hover:bg-white/5 hover:text-white": !["problems", "changes", "history"].includes(activeView()),
              }}
              onClick={() => setToolsOpen(!toolsOpen())}
            >
              Tools⌄
            </button>
            <Show when={toolsOpen()}>
              <div class="absolute right-1 top-11 z-20 w-48 overflow-hidden rounded-2xl border border-[#3a2f4b] bg-[#141318] p-1 shadow-[0_18px_45px_rgba(0,0,0,0.42)]">
                {[
                  { view: "problems", label: "Problems", meta: problems().length ? String(problems().length) : "" },
                  { view: "changes", label: "Change Queue", meta: queueCount() ? String(queueCount()) : "" },
                  { view: "history", label: "Checkpoints", meta: selectedCheckpoints().length ? String(selectedCheckpoints().length) : "" },
                ].map((item) => (
                  <button
                    class="flex h-9 w-full items-center justify-between rounded-xl px-3 text-left text-12-medium text-[#cfc6de] transition duration-200 ease-out hover:bg-white/8 hover:text-white"
                    onClick={() => {
                      setActiveView(item.view as CodespaceView)
                      setToolsOpen(false)
                    }}
                  >
                    <span>{item.label}</span>
                    <Show when={item.meta}><span class="rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] text-violet-100">{item.meta}</span></Show>
                  </button>
                ))}
              </div>
            </Show>
          </nav>

          <div class="flex min-w-[222px] justify-end items-center gap-1.5 text-12-medium text-[#9d91af]">
            <button class="rounded-xl px-2.5 py-1.5 transition duration-200 ease-out hover:bg-white/5 hover:text-white" onClick={() => openCodespaceTool("debugger")}>Debug</button>
            <button class="rounded-xl px-2.5 py-1.5 transition duration-200 ease-out hover:bg-white/5 hover:text-white" onClick={exportCurrentFile}>Export⌄</button>
          </div>
        </div>
      </header>

      <main class="min-h-0 flex-1 flex">
        <aside class="w-[252px] shrink-0 border-r border-[#2b2438] bg-[#17111f]">
          <div class="flex h-10 items-center justify-between border-b border-[#2b2438] px-3">
            <div class="text-12-medium uppercase tracking-[0.18em] text-[#9084a4]">Files</div>
          </div>
          <div class="h-[calc(100%-3rem)] overflow-auto px-1 py-2 group/filetree">
            <Switch>
              <Match when={file.tree.state("")?.loaded && file.tree.children("").length === 0}>{props.empty()}</Match>
              <Match when={true}>
                <FileTree
                  path=""
                  class="py-1"
                  modified={props.modified()}
                  kinds={props.kinds()}
                  active={selectedPath()}
                  onFileClick={(node) => openFile(node.path)}
                />
              </Match>
            </Switch>
          </div>
        </aside>

        <section class="min-w-0 flex-1 flex flex-col bg-[#202631]">
          <Show
            when={selectedPath()}
            fallback={
              <div class="h-full flex items-center justify-center px-8 text-center bg-[#131217]">
                <div class="max-w-72">
                  <img src="/vector-logo.png" alt="" class="mx-auto mb-5 size-12 rounded-xl opacity-80" draggable={false} />
                  <div class="text-18-medium text-white">Open a file in Codespace.</div>
                  <div class="mt-2 text-13-regular text-[#a8adba]">Choose a file from the left to edit, preview, debug, or checkpoint it.</div>
                </div>
              </div>
            }
          >
            {(path) => (
              <Switch>
                <Match when={state()?.loaded}>
                  <Switch>
                    <Match when={activeView() === "editor"}>
                      <div class="h-full min-h-0 flex flex-col overflow-hidden bg-[#202631]">
                        <div class="h-[46px] shrink-0 flex items-center justify-between border-b border-[#1c2029] bg-[#111017] px-3">
                          <div class="min-w-0 flex items-center gap-3">
                            <span class="size-2.5 rounded-full bg-[#9b6cff]" />
                            <span class="truncate font-mono text-[13px] text-white">{fileBasename(path())}</span>
                            <span class={`rounded-lg border px-2 py-0.5 text-11-medium ${activeBadge().ring} ${activeBadge().color}`}>
                              ‹/› {activeBadge().label}
                            </span>
                            <span class="rounded-full border border-red-400/30 bg-red-500/10 px-2 py-0.5 text-10-medium text-red-200">
                              {breakpointCount()} bp
                            </span>
                          </div>
                          <div class="flex items-center gap-2">
                            <button class="rounded-full bg-[#191821] px-2.5 py-1 text-11-medium text-[#6f6879]" disabled>Def</button>
                            <button class="rounded-full bg-[#191821] px-2.5 py-1 text-11-medium text-[#6f6879]" disabled>Rename</button>
                            <button class="rounded-full border border-[#3a3048] bg-[#1b1723] px-2.5 py-1 text-11-medium text-[#d1c6df] transition duration-200 ease-out hover:bg-[#251d31]" onClick={() => openCodespaceTool("debugger")}>
                              ✧ AI Debugger
                            </button>
                            <button class="rounded-full border border-[#7c4ee7]/50 bg-[#2a1d43] px-2.5 py-1 text-11-medium text-[#a978ff]">
                              ⚙ Engine-managed
                            </button>
                            <button class="rounded-full border border-[#3a3048] bg-[#1b1723] px-2.5 py-1 text-11-medium text-[#d1c6df] transition duration-200 ease-out hover:bg-[#251d31]" onClick={copyCurrentFile}>
                              Copy
                            </button>
                          </div>
                        </div>
                        <div class="min-h-0 flex-1 overflow-hidden bg-[#131217]">
                          <VectorCodeEditor
                            path={path()}
                            value={draft()}
                            onChange={(next) => setDrafts(path(), next)}
                          />
                        </div>
                      </div>
                    </Match>

                    <Match when={activeView() === "preview"}>
                      <Show
                        when={previewDocument()}
                        fallback={
                          <div class="h-full flex items-center justify-center bg-[#131217] px-8 text-center">
                            <div class="max-w-md rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#161519] p-6 shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
                              <img src="/vector-logo.png" alt="" class="mx-auto mb-4 size-10 rounded-xl opacity-80" draggable={false} />
                              <div class="text-16-medium text-white">No web preview yet.</div>
                              <div class="mt-2 text-13-regular leading-relaxed text-[#a8adba]">
                                Open or create an HTML entry file and Vector will render it here with matching local CSS and JavaScript.
                              </div>
                            </div>
                          </div>
                        }
                      >
                        {(document) => (
                          <iframe
                            title="Vector Codespace Preview"
                            sandbox="allow-scripts allow-forms allow-same-origin"
                            srcdoc={document()}
                            class="h-full w-full border-0 bg-white"
                          />
                        )}
                      </Show>
                    </Match>

                    <Match when={activeView() === "problems"}>
                      <div class="h-full overflow-auto bg-[#131217] p-5">
                        <For
                          each={problems()}
                          fallback={
                            <div class="rounded-2xl border border-emerald-400/20 bg-emerald-500/8 p-4 text-13-regular text-emerald-100">
                              No obvious local problems detected in this file.
                            </div>
                          }
                        >
                          {(problem) => (
                            <div class="mb-3 rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#161519] p-4">
                              <div class="flex items-center justify-between gap-3">
                                <div class="text-13-medium text-text-base">Line {problem.line}</div>
                                <div class="flex items-center gap-2">
                                  <div
                                    class="rounded-full px-2 py-0.5 text-11-medium uppercase"
                                    classList={{
                                      "bg-red-500/15 text-red-200": problem.severity === "error",
                                      "bg-amber-500/15 text-amber-200": problem.severity === "warning",
                                      "bg-sky-500/15 text-sky-200": problem.severity === "info",
                                    }}
                                  >
                                    {problem.severity}
                                  </div>
                                  <button
                                    class="rounded-full border border-violet-400/35 bg-violet-500/15 px-3 py-1 text-12-medium text-violet-100 hover:bg-violet-500/25"
                                    onClick={() => debugProblem(problem)}
                                  >
                                    Debug
                                  </button>
                                </div>
                              </div>
                              <div class="mt-2 text-13-regular text-text-weak">{problem.message}</div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Match>

                    <Match when={activeView() === "changes"}>
                      <div class="h-full min-h-0 flex flex-col bg-[#100f14]">
                        <header class="shrink-0 border-b border-[#2b2438] bg-[#14101c] px-6 py-5">
                          <div class="flex items-center justify-between gap-4">
                            <div class="flex items-center gap-3">
                              <div class="flex size-11 items-center justify-center rounded-2xl bg-[#2a1647] text-violet-300">⎇</div>
                              <div>
                                <div class="text-18-medium text-white">Vector Change Queue</div>
                                <div class="text-12-regular text-[#8a8595]">
                                  {queuedChanges().length} staged Codespace edit{queuedChanges().length === 1 ? "" : "s"} · {props.diffs().length} engine review change{props.diffs().length === 1 ? "" : "s"}
                                </div>
                              </div>
                            </div>
                            <div class="flex items-center gap-2">
                              <button
                                class="rounded-xl border border-[#352845] bg-[#1d1728] px-4 py-2 text-13-medium text-[#cfc6de] hover:bg-[#251d31]"
                                onClick={() => setActiveView("coprogrammer")}
                              >
                                Back to Co-Programmer
                              </button>
                              <Show when={selectedQueue()}>
                                {(item) => (
                                  <>
                                    <button
                                      class="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-13-medium text-red-100 hover:bg-red-500/20"
                                      onClick={() => rejectQueuedChange(item().id)}
                                    >
                                      Reject
                                    </button>
                                    <button
                                      class="rounded-xl bg-[#7c3aed] px-4 py-2 text-13-medium text-white hover:bg-[#8b5cf6] disabled:opacity-50"
                                      disabled={saving()}
                                      onClick={() => void acceptQueuedChange(item())}
                                    >
                                      {saving() ? "Applying..." : "Accept"}
                                    </button>
                                  </>
                                )}
                              </Show>
                            </div>
                          </div>
                        </header>

                        <div class="grid min-h-0 flex-1 grid-cols-[360px_1fr]">
                          <aside class="min-h-0 overflow-y-auto border-r border-[#2b2438] bg-[#17111f] p-4">
                            <For
                              each={queuedChanges()}
                              fallback={
                                <div class="rounded-2xl border border-[#352845] bg-[#0f0c15] p-4 text-13-regular text-[#8a8595]">
                                  No Codespace edits are queued. Run Co-Programmer to stage a proposal.
                                </div>
                              }
                            >
                              {(item) => (
                                <button
                                  class="mb-3 w-full rounded-2xl border p-4 text-left transition"
                                  classList={{
                                    "border-[#8b5cf6] bg-[#24183a]": selectedQueueId() === item.id,
                                    "border-[#352845] bg-[#0f0c15] hover:border-[#5a4474]": selectedQueueId() !== item.id,
                                  }}
                                  onClick={() => setSelectedQueueId(item.id)}
                                >
                                  <div class="flex items-center justify-between gap-3">
                                    <div class="truncate font-mono text-13-medium text-white">{item.path}</div>
                                    <span class="rounded-full bg-violet-500/15 px-2 py-0.5 text-10-medium text-violet-200">Queued</span>
                                  </div>
                                  <div class="mt-2 line-clamp-2 text-12-regular text-[#8a8595]">{item.source}</div>
                                </button>
                              )}
                            </For>

                            <Show when={props.diffs().length}>
                              <div class="mt-5 border-t border-[#2b2438] pt-4">
                                <div class="mb-3 text-11-medium uppercase tracking-[0.18em] text-[#8a8595]">Engine Review</div>
                                <For each={props.diffs()}>
                                  {(diff) => (
                                    <button
                                      class="mb-2 w-full rounded-2xl border border-[#352845] bg-[#0f0c15] p-3 text-left hover:border-[#5a4474]"
                                      onClick={() => props.focusReviewDiff(diff.file)}
                                    >
                                      <div class="truncate text-12-medium text-white">{diff.file}</div>
                                      <div class="mt-1 text-11-medium">
                                        <span class="text-emerald-300">+{diff.additions}</span>{" "}
                                        <span class="text-red-300">-{diff.deletions}</span>
                                      </div>
                                    </button>
                                  )}
                                </For>
                              </div>
                            </Show>
                          </aside>

                          <section class="min-h-0 overflow-auto bg-[#131217]">
                            <Show
                              when={selectedQueue()}
                              fallback={
                                <div class="flex h-full items-center justify-center px-6 text-center text-13-regular text-[#a8adba]">
                                  Select a queued edit to inspect its full file preview.
                                </div>
                              }
                            >
                              {(item) => (
                                <div class="p-5">
                                  <div class="mb-4 flex items-center justify-between gap-4">
                                    <div>
                                      <div class="font-mono text-18-medium text-white">{item().path}</div>
                                      <div class="mt-1 text-12-regular text-[#a8adba]">New or changed lines are highlighted in green.</div>
                                    </div>
                                    <div class="rounded-full bg-[#141318] px-3 py-1 text-12-medium text-[#cfc6de]">
                                      {previewDiffLines(item().oldContent, item().newContent).filter((row) => row.added).length} changed lines
                                    </div>
                                  </div>
                                  <div class="overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#161519] font-mono text-[13px] leading-6">
                                    <For each={previewDiffLines(item().oldContent, item().newContent)}>
                                      {(row) => (
                                        <div
                                          class="grid grid-cols-[68px_1fr] border-b border-white/[0.025]"
                                          classList={{
                                            "bg-emerald-500/12 text-emerald-100": row.added,
                                            "text-[#c5ccd8]": !row.added,
                                          }}
                                        >
                                          <div class="select-none border-r border-white/[0.04] px-3 py-1 text-right text-[#7f8a9a]">{row.number}</div>
                                          <pre class="overflow-x-auto px-3 py-1">{row.line || " "}</pre>
                                        </div>
                                      )}
                                    </For>
                                  </div>
                                </div>
                              )}
                            </Show>
                          </section>
                        </div>
                      </div>
                    </Match>

                    <Match when={activeView() === "history"}>
                      <div class="h-full overflow-auto bg-[#131217] p-5">
                        <For
                          each={selectedCheckpoints()}
                          fallback={
                            <div class="rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#161519] p-4 text-13-regular text-[#a8adba]">
                              No checkpoints for this file yet. Create one before risky edits.
                            </div>
                          }
                        >
                          {(item) => (
                            <div class="mb-3 rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#161519] p-4">
                              <div class="flex items-center justify-between gap-3">
                                <div>
                                  <div class="text-13-medium text-white">{item.title}</div>
                                  <div class="mt-1 text-12-regular text-[#a8adba]">{formatCheckpointTime(item.createdAt)}</div>
                                </div>
                                <div class="flex gap-2">
                                  <button class="rounded-full bg-white/8 px-3 py-1.5 text-12-medium" onClick={() => restoreCheckpoint(item)}>
                                    Restore
                                  </button>
                                  <button class="rounded-full bg-white/8 px-3 py-1.5 text-12-medium" onClick={() => removeCheckpoint(item.id)}>
                                    Delete
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Match>

                    <Match when={["debugger", "architect", "coprogrammer"].includes(activeView())}>
                      <Switch>
                        <Match when={activeView() === "coprogrammer"}>
                          <div class="h-full min-h-0 flex bg-[#0d0914]">
                            <aside class="w-[360px] shrink-0 overflow-y-auto border-r border-[rgba(255,255,255,0.08)] bg-[#16101f] p-5">
                              <div class="mb-5 flex items-center gap-3">
                                <div class="flex size-11 items-center justify-center rounded-2xl bg-[#2a1647] text-violet-300">⌘</div>
                                <div>
                                  <div class="text-16-medium text-white">Vector Co-Programmer</div>
                                  <div class="text-12-regular text-[#8a8595]">Plan, generate, queue, review · {activeModelLabel()}</div>
                                </div>
                              </div>

                              <div class="grid grid-cols-2 gap-2">
                                {[
                                  { id: "build", label: "Build", detail: "Create or extend features", icon: "↗" },
                                  { id: "repair", label: "Repair", detail: "Fix broken projects", icon: "⚙" },
                                  { id: "refactor", label: "Refactor", detail: "Improve structure", icon: "⌘" },
                                  { id: "learn", label: "Learn", detail: "Explain while building", icon: "□" },
                                ].map((item) => (
                                  <button
                                    class="rounded-2xl border p-4 text-left transition hover:border-[#8257e6] hover:bg-[#201433] hover:text-white"
                                    classList={{
                                      "border-[#8257e6] bg-[#201433] text-white": coprogrammerMode() === item.id,
                                      "border-[rgba(255,255,255,0.08)] bg-[#111019] text-[#8f849f]": coprogrammerMode() !== item.id,
                                    }}
                                    onClick={() => setCoprogrammerMode(item.id as "build" | "repair" | "refactor" | "learn")}
                                  >
                                    <div class="mb-2 flex items-center gap-2">
                                      <span class="text-violet-400">{item.icon}</span>
                                      <span class="text-13-medium">{item.label}</span>
                                    </div>
                                    <div class="text-12-regular leading-relaxed">{item.detail}</div>
                                  </button>
                                ))}
                              </div>

                              <textarea
                                value={toolBrief()}
                                onInput={(event) => setToolBrief(event.currentTarget.value)}
                                placeholder="Describe the feature, bug, refactor, or lesson for this Codespace..."
                                class="mt-4 h-40 w-full resize-none rounded-2xl border border-[#322841] bg-[#100f14] p-4 text-14-regular leading-relaxed text-white outline-none placeholder:text-[#6e6a7b] focus:border-[#8b5cf6]"
                              />

                              <div class="mt-4 flex flex-wrap gap-2">
                                {[
                                  "Add a feature",
                                  "Repair issues",
                                  "Refactor safely",
                                ].map((label) => (
                                  <button
                                    class="rounded-xl border border-[rgba(255,255,255,0.08)] bg-white/[0.03] px-3 py-2 text-12-medium text-[#a89cb9] hover:border-[#8257e6] hover:text-violet-300"
                                    onClick={() => setToolBrief(label)}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>

                              <button
                                class="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#7c3aed] text-14-medium text-white hover:bg-[#8b5cf6]"
                                disabled={coprogrammerRunning()}
                                onClick={() => void runCoprogrammer()}
                              >
                                {coprogrammerRunning() ? "Running..." : "▷ Run Co-Programmer"}
                              </button>

                              <div class="mt-6 border-t border-[rgba(255,255,255,0.08)] pt-4">
                                <div class="mb-3 text-11-medium uppercase tracking-[0.18em] text-[#8a8595]">Execution Trace</div>
                                <For
                                  each={
                                    coprogrammerLog().length
                                      ? coprogrammerLog()
                                      : [
                                          { status: "done", label: "Indexed workspace", detail: `${props.modified().length || 1} file${props.modified().length === 1 ? "" : "s"} available to inspect` },
                                          { status: "info", label: "Planning task", detail: selectedPath() ? `Active file: ${fileBasename(selectedPath())}` : "Open a file to focus context" },
                                          { status: "info", label: "Queue safety", detail: "Changes remain reviewable before acceptance" },
                                        ]
                                  }
                                >
                                  {(row) => (
                                  <div class="mb-2 rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#100f14] p-3">
                                    <div class="flex items-center gap-2 text-13-medium text-white">
                                      <span
                                        class="size-2 rounded-full"
                                        classList={{
                                          "bg-emerald-400": row.status === "done",
                                          "bg-sky-400": row.status === "info",
                                          "bg-amber-400": row.status === "warn",
                                          "bg-red-400": row.status === "error",
                                        }}
                                      />
                                      {row.label}
                                    </div>
                                    <div class="mt-1 pl-4 text-12-regular text-[#8a8595]">{row.detail}</div>
                                  </div>
                                  )}
                                </For>
                              </div>
                            </aside>

                            <section class="min-w-0 flex-1 overflow-y-auto bg-[#100f14]">
                              <div class="border-b border-[rgba(255,255,255,0.08)] bg-[#141318] px-6 py-5">
                                <div class="flex items-center justify-between gap-4">
                                  <div class="flex items-center gap-3">
                                    <img src="/vector-logo.png" alt="" class="size-10 rounded-xl" draggable={false} />
                                    <div>
                                      <div class="text-16-medium text-white">Co-Programmer Output</div>
                                      <div class="text-12-regular text-[#8a8595]">Review the plan, then inspect generated files in Changes. Model: {activeModelLabel()}</div>
                                    </div>
                                  </div>
                                  <button class="rounded-xl bg-[#7c3aed] px-4 py-2 text-13-medium text-white hover:bg-[#8b5cf6]" onClick={() => setActiveView("changes")}>
                                    Review {queuedChanges().length || queueCount()}
                                  </button>
                                </div>
                              </div>

                              <div class="grid grid-cols-4 gap-4 border-b border-[rgba(255,255,255,0.08)] p-6">
                                <div class="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-4">
                                  <div class="text-11-medium uppercase tracking-[0.16em] text-[#8a8595]">Mode</div>
                                  <div class="mt-2 text-18-medium text-white">{coprogrammerMode()}</div>
                                </div>
                                <div class="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-4">
                                  <div class="text-11-medium uppercase tracking-[0.16em] text-[#8a8595]">Queued</div>
                                  <div class="mt-2 text-18-medium text-white">{queuedChanges().length}</div>
                                </div>
                                <div class="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-4">
                                  <div class="text-11-medium uppercase tracking-[0.16em] text-[#8a8595]">Problems</div>
                                  <div class="mt-2 text-18-medium text-white">{problems().length}</div>
                                </div>
                                <div class="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-4">
                                  <div class="text-11-medium uppercase tracking-[0.16em] text-[#8a8595]">File</div>
                                  <div class="mt-2 truncate text-18-medium text-white">{fileBasename(path())}</div>
                                </div>
                              </div>

                              <div class="p-6">
                                <div class="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-6">
                                  <div class="mb-4 text-18-medium text-white">{coprogrammerDraft() ? "Generated Plan" : "Plan"}</div>
                                  <Show
                                    when={coprogrammerDraft()}
                                    fallback={
                                      <ul class="space-y-3 text-14-regular leading-relaxed text-[#d6d2df]">
                                        <li>• Inspect the active file and nearby project structure.</li>
                                        <li>• Keep the edit scoped instead of rewriting the whole project.</li>
                                        <li>• Create a checkpoint before risky changes.</li>
                                        <li>• Send generated file changes to review before they touch the workspace.</li>
                                      </ul>
                                    }
                                  >
                                    {(text) => <pre class="whitespace-pre-wrap text-14-regular leading-relaxed text-[#d6d2df]">{text()}</pre>}
                                  </Show>
                                </div>
                              </div>
                            </section>
                          </div>
                        </Match>

                        <Match when={activeView() === "architect"}>
                          <div class="h-full min-h-0 flex flex-col bg-[#100f14]">
                            <header class="flex items-center gap-3 border-b border-[rgba(255,255,255,0.08)] bg-[#141318] px-5 py-4">
                              <div class="flex size-10 items-center justify-center rounded-2xl bg-[#2a1647] text-violet-300">✧</div>
                              <div class="min-w-0 flex-1">
                                <div class="text-16-medium text-white">AI Architect</div>
                                <div class="text-12-regular text-[#8a8595]">Chat with the active Vector model context for planning and review · {activeModelLabel()}</div>
                              </div>
                              <button class="rounded-full bg-white/8 px-4 py-2 text-13-medium text-[#d6d2df] hover:bg-white/12" onClick={() => setActiveView("editor")}>
                                Back to editor
                              </button>
                            </header>

                            <div class="min-h-0 flex-1 overflow-y-auto p-6">
                              <div class="mx-auto flex max-w-5xl flex-col gap-4">
                                <div class="grid gap-3 sm:grid-cols-4">
                                  <div class="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-4">
                                    <div class="text-11-medium uppercase tracking-[0.16em] text-[#8a8595]">File</div>
                                    <div class="mt-2 truncate text-14-medium text-white">{fileBasename(path())}</div>
                                  </div>
                                  <div class="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-4">
                                    <div class="text-11-medium uppercase tracking-[0.16em] text-[#8a8595]">Language</div>
                                    <div class="mt-2 text-14-medium text-white">{fileLanguage(path())}</div>
                                  </div>
                                  <div class="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-4">
                                    <div class="text-11-medium uppercase tracking-[0.16em] text-[#8a8595]">Issues</div>
                                    <div class="mt-2 text-14-medium text-white">{problems().length}</div>
                                  </div>
                                  <div class="rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-4">
                                    <div class="text-11-medium uppercase tracking-[0.16em] text-[#8a8595]">Queue</div>
                                    <div class="mt-2 text-14-medium text-white">{queuedChanges().length}</div>
                                  </div>
                                </div>

                                <div class="min-h-[420px] rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#141318] p-5">
                                  <For each={architectMessages()}>
                                    {(message) => (
                                      <div
                                        class="mb-4 flex"
                                        classList={{
                                          "justify-end": message.role === "user",
                                          "justify-start": message.role === "assistant",
                                        }}
                                      >
                                        <div
                                          class="max-w-[78%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-14-regular leading-relaxed"
                                          classList={{
                                            "bg-[#7c3aed] text-white": message.role === "user",
                                            "border border-[rgba(255,255,255,0.08)] bg-[#100f14] text-[#d6d2df]": message.role === "assistant",
                                          }}
                                        >
                                          {message.content}
                                        </div>
                                      </div>
                                    )}
                                  </For>
                                  <Show when={architectRunning()}>
                                    <div class="text-13-regular text-[#8a8595]">AI Architect is thinking...</div>
                                  </Show>
                                </div>
                              </div>
                            </div>

                            <footer class="shrink-0 border-t border-[rgba(255,255,255,0.08)] bg-[#141318] p-4">
                              <div class="mx-auto flex max-w-5xl gap-3">
                                <textarea
                                  value={architectInput()}
                                  onInput={(event) => setArchitectInput(event.currentTarget.value)}
                                  onKeyDown={(event) => {
                                    if (event.key !== "Enter" || event.shiftKey) return
                                    event.preventDefault()
                                    void sendArchitectMessage()
                                  }}
                                  placeholder="Ask AI Architect to review structure, explain a file, or plan a safe edit..."
                                  class="min-h-16 flex-1 resize-none rounded-2xl border border-[rgba(255,255,255,0.08)] bg-[#100f14] px-4 py-3 text-14-regular text-white outline-none placeholder:text-[#6e6a7b] focus:border-[#8b5cf6]"
                                />
                                <button
                                  class="h-16 rounded-2xl bg-[#7c3aed] px-5 text-14-medium text-white hover:bg-[#8b5cf6] disabled:opacity-50"
                                  disabled={architectRunning()}
                                  onClick={() => void sendArchitectMessage()}
                                >
                                  Send
                                </button>
                              </div>
                            </footer>
                          </div>
                        </Match>

                        <Match when={activeView() === "debugger"}>
                          <div class="h-full overflow-auto bg-[#131217] p-5">
                            <div class="mx-auto max-w-4xl rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#161519] p-6 shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
                              <div class="flex items-start justify-between gap-4">
                                <div class="flex items-center gap-4">
                                  <img src="/vector-logo.png" alt="" class="size-10 rounded-xl" draggable={false} />
                                    <div>
                                      <div class="text-20-medium text-white">{toolTitle(activeView() as CodespaceToolView)}</div>
                                      <div class="mt-1 text-13-regular text-[#a8adba]">
                                      Focused diagnostics for the file open in Codespace. Model: {activeModelLabel()}.
                                      </div>
                                    </div>
                                </div>
                                <button class="rounded-full bg-white/8 px-4 py-2 text-13-medium text-[#d6d2df] hover:bg-white/12" onClick={() => setActiveView("editor")}>
                                  Back to editor
                                </button>
                              </div>

                              <div class="mt-6 rounded-2xl border border-[#343b48] bg-[#131720] p-5">
                                <div class="text-15-medium text-white">Local diagnostic scan</div>
                                <div class="mt-2 text-13-regular text-[#a8adba]">
                                  Vector checked the open draft for common syntax, secret, and shipping issues.
                                </div>
                                <div class="mt-4 grid gap-3 sm:grid-cols-3">
                                  <div class="rounded-2xl bg-red-500/10 p-4 text-red-100">
                                    <div class="text-22-medium">{problemCounts().errors}</div>
                                    <div class="text-11-medium uppercase tracking-[0.16em]">Errors</div>
                                  </div>
                                  <div class="rounded-2xl bg-amber-500/10 p-4 text-amber-100">
                                    <div class="text-22-medium">{problemCounts().warnings}</div>
                                    <div class="text-11-medium uppercase tracking-[0.16em]">Warnings</div>
                                  </div>
                                  <div class="rounded-2xl bg-sky-500/10 p-4 text-sky-100">
                                    <div class="text-22-medium">{problemCounts().info}</div>
                                    <div class="text-11-medium uppercase tracking-[0.16em]">Notes</div>
                                  </div>
                                </div>
                                <button class="mt-5 rounded-full bg-violet-500 px-4 py-2 text-13-medium text-white hover:bg-violet-400" onClick={() => setActiveView("problems")}>
                                  Open problems
                                </button>
                                <button
                                  class="ml-2 mt-5 rounded-full border border-violet-400/35 bg-violet-500/10 px-4 py-2 text-13-medium text-violet-100 hover:bg-violet-500/20"
                                  onClick={() => {
                                    if (!toolBrief()) {
                                      const first = problems()[0]
                                      setToolBrief(first ? `Repair ${path()} line ${first.line}: ${first.message}` : `Review and harden ${path()}`)
                                    }
                                    setCoprogrammerMode("repair")
                                    setActiveView("coprogrammer")
                                  }}
                                >
                                  Repair with Co-Programmer
                                </button>
                              </div>
                            </div>
                          </div>
                        </Match>
                      </Switch>
                    </Match>
                  </Switch>
                </Match>
                <Match when={state()?.loading}>
                  <div class="px-6 py-5 text-13-regular text-[#a8adba]">Loading {path()}...</div>
                </Match>
                <Match when={state()?.error}>
                  {(err) => <div class="px-6 py-5 text-13-regular text-[#a8adba]">{err()}</div>}
                </Match>
              </Switch>
            )}
          </Show>
        </section>
      </main>
    </div>
  )
}

function StableCodespaceWorkbench(props: {
  modified: () => readonly string[]
  kinds: () => ReadonlyMap<string, Kind>
  empty: () => JSX.Element
  diffs: () => readonly RenderDiff[]
  focusReviewDiff: (path: string) => void
  sessionKey: () => string
  onClose: () => void
}) {
  const file = useFile()
  const sdk = useSDK()
  const local = useLocal()
  const prompt = usePrompt()
  const command = useCommand()
  const [selectedPath, setSelectedPath] = createSignal<string | undefined>()
  const [activeView, setActiveView] = createSignal<"editor" | "preview" | "problems">("editor")
  const [saving, setSaving] = createSignal(false)
  const [drafts, setDrafts] = createStore<Record<string, string>>({})

  const state = createMemo(() => {
    const path = selectedPath()
    if (!path) return
    return file.get(path)
  })
  const contents = createMemo(() => state()?.content?.content ?? "")
  const draft = createMemo(() => {
    const path = selectedPath()
    if (!path) return ""
    return drafts[path] ?? contents()
  })
  const dirty = createMemo(() => Boolean(selectedPath()) && draft() !== contents())
  const activeBadge = createMemo(() => fileBadge(selectedPath()))
  const lineCount = createMemo(() => (draft() ? draft().split("\n").length : 0))
  const problems = createMemo(() => analyzeCodespaceProblems(selectedPath(), draft()))
  const modifiedSet = createMemo(() => new Set(props.modified()))

  const fileText = (path: string | undefined) => {
    if (!path) return ""
    return drafts[path] ?? file.get(path)?.content?.content ?? ""
  }

  const previewCandidates = createMemo(() => {
    const current = selectedPath()
    const candidates = new Set<string>()
    if (current) {
      candidates.add(current)
      const dir = pathDirname(current)
      candidates.add(dir ? `${dir}/index.html` : "index.html")
      candidates.add(dir ? `${dir}/index.htm` : "index.htm")
    }
    candidates.add("index.html")
    candidates.add("index.htm")
    candidates.add("dist/index.html")
    candidates.add("build/index.html")
    candidates.add("src/index.html")
    candidates.add("public/index.html")
    for (const path of props.modified()) candidates.add(path)
    return [...candidates].filter((path) => isHtmlPath(path) || looksLikeHtml(fileText(path)))
  })

  const previewPath = createMemo(() => {
    const candidates = previewCandidates()
    const built = candidates.find((path) => isBuiltPreviewPath(path) && looksLikeHtml(fileText(path)))
    if (built) return built
    return candidates.find((path) => looksLikeHtml(fileText(path))) ?? candidates.find((path) => fileText(path).trim()) ?? candidates[0]
  })

  const previewDocument = createMemo(() => {
    const path = previewPath()
    const html = fileText(path)
    if (!path || !html.trim()) return ""
    return buildPreviewDocument(path, html, fileText)
  })

  const openFile = (path: string) => {
    setSelectedPath(path)
    setActiveView("editor")
    void file.load(path)
  }

  const sendProblemToAgent = (problem: CodespaceProblem, mode: "fix" | "explain") => {
    const path = selectedPath()
    if (!path) return
    const lines = draft().split("\n")
    const start = Math.max(0, problem.line - 4)
    const excerpt = lines
      .slice(start, problem.line + 3)
      .map((line, index) => `${start + index + 1}: ${line}`)
      .join("\n")
    const fence = "```"
    const context = `\n\nContext:\n${fence}\n${excerpt}\n${fence}\n\n`
    const text =
      mode === "fix"
        ? `Fix this problem in ${path} at line ${problem.line}: ${problem.message}${context}Make the smallest safe change and keep it reviewable.`
        : `Explain this problem in ${path} at line ${problem.line}: ${problem.message}${context}Explain what causes it, why it matters, and how to fix it.`
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    props.onClose()
    command.trigger("input.focus")
    showToast({
      title: mode === "fix" ? "Repair request ready" : "Explanation request ready",
      description: "The exact file, line, and code context are in the prompt. Send when ready.",
    })
  }

  const saveCurrentFile = async (options?: { silent?: boolean; path?: string; content?: string; base?: string }) => {
    const path = options?.path ?? selectedPath()
    if (!path) return
    const nextContent = options?.content ?? draft()
    const baseContent = options?.base ?? contents()
    if (nextContent === baseContent) {
      if (!options?.silent) showToast({ title: "Already saved", description: "There are no local changes to save." })
      return
    }
    setSaving(true)
    try {
      await sdk().client.file.write({ directory: sdk().directory, path, content: nextContent })
      await file.load(path, { force: true })
      await file.tree.refresh("")
      setDrafts(path, nextContent)
      const secrets = detectSecrets(nextContent)
      if (secrets.length > 0) {
        showToast({
          variant: "error",
          title: "Possible secret in " + fileBasename(path),
          description: `Looks like ${secrets.join(", ")}. Move real keys into environment variables before sharing or committing.`,
        })
      }
      if (!options?.silent) showToast({ title: "Saved", description: `${path} was saved locally.` })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not save file",
        description: error instanceof Error && error.message ? error.message : "Vector could not write this file.",
      })
    } finally {
      setSaving(false)
    }
  }

  const copyCurrentFile = async () => {
    const path = selectedPath()
    if (!path) return
    await navigator.clipboard.writeText(draft())
    showToast({ title: "Copied", description: `${path} copied to clipboard.` })
  }

  const exportCurrentFile = () => {
    const path = selectedPath()
    if (!path) return
    const blob = new Blob([draft()], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = fileBasename(path)
    link.click()
    URL.revokeObjectURL(url)
  }

  createEffect(() => {
    const path = selectedPath()
    if (!path || !state()?.loaded || drafts[path] !== undefined) return
    setDrafts(path, contents())
  })

  createEffect(() => {
    if (selectedPath()) return
    const first = props.modified()[0]
    if (first) openFile(first)
  })

  createEffect(() => {
    if (activeView() !== "preview") return
    const candidates = previewCandidates()
    const path = previewPath()
    const html = path ? fileText(path) : ""
    untrack(() => {
      void file.load("package.json").catch(() => {})
      for (const candidate of candidates) void file.load(candidate).catch(() => {})
      if (!path || !html.trim()) return
      for (const asset of previewAssetRefs(path, html)) void file.load(asset).catch(() => {})
    })
  })

  let autosaveTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => [selectedPath(), draft(), contents(), Boolean(state()?.loaded)] as const,
      ([path, nextContent, baseContent, loaded]) => {
        if (!path || !loaded || nextContent === baseContent) return
        if (autosaveTimer) clearTimeout(autosaveTimer)
        autosaveTimer = setTimeout(() => {
          void saveCurrentFile({ path, content: nextContent, base: baseContent, silent: true })
        }, 900)
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    if (autosaveTimer) clearTimeout(autosaveTimer)
  })

  return (
    <div class="h-full min-h-0 flex flex-col overflow-hidden bg-[#0c0911] text-[#ebe7f5]">
      <header class="h-[72px] shrink-0 border-b border-[rgba(255,255,255,0.08)] bg-[#15101f]">
        <div class="flex h-full items-center gap-3 px-3">
          <button
            class="flex size-8 items-center justify-center rounded-xl text-[#9589a7] transition duration-200 hover:bg-white/6 hover:text-white"
            aria-label="Back to Vector Agent"
            onClick={props.onClose}
          >
            ‹
          </button>
          <img src="/vector-logo.png" alt="" class="size-8 rounded-xl shadow-[0_0_18px_rgba(139,92,246,0.35)]" draggable={false} />

          <nav class="mx-auto flex items-center gap-1 rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#1b1a21] p-1">
            <button
              class="h-7 rounded-xl px-3 text-12-medium transition duration-200"
              classList={{
                "bg-[#6d3bd2] text-white shadow-[0_0_18px_rgba(139,92,246,0.3)]": activeView() === "editor",
                "text-[#a9a4b5] hover:bg-white/6 hover:text-white": activeView() !== "editor",
              }}
              onClick={() => setActiveView("editor")}
            >
              Editor
            </button>
            <button
              class="h-7 rounded-xl px-3 text-12-medium transition duration-200"
              classList={{
                "bg-[#6d3bd2] text-white shadow-[0_0_18px_rgba(139,92,246,0.3)]": activeView() === "preview",
                "text-[#a9a4b5] hover:bg-white/6 hover:text-white": activeView() !== "preview",
              }}
              onClick={() => setActiveView("preview")}
            >
              Preview
            </button>
            <button
              class="h-7 rounded-xl px-3 text-12-medium transition duration-200"
              classList={{
                "bg-[#6d3bd2] text-white shadow-[0_0_18px_rgba(139,92,246,0.3)]": activeView() === "problems",
                "text-[#a9a4b5] hover:bg-white/6 hover:text-white": activeView() !== "problems",
              }}
              onClick={() => setActiveView("problems")}
            >
              Problems
              <Show when={problems().length > 0}>
                <span class="ml-2 rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">{problems().length}</span>
              </Show>
            </button>
          </nav>

          <div class="flex items-center gap-1.5">
            <button
              class="rounded-xl px-3 py-1.5 text-12-medium transition duration-200 hover:bg-white/6 hover:text-white"
              classList={{
                "text-violet-200": dirty(),
                "text-[#a9a4b5]": !dirty(),
              }}
              disabled={saving() || !selectedPath()}
              onClick={() => void saveCurrentFile()}
            >
              {saving() ? "Saving..." : dirty() ? "Save" : "Saved"}
            </button>
            <button class="rounded-xl px-3 py-1.5 text-12-medium text-[#a9a4b5] transition duration-200 hover:bg-white/6 hover:text-white" onClick={copyCurrentFile}>
              Copy
            </button>
            <button class="rounded-xl px-3 py-1.5 text-12-medium text-[#a9a4b5] transition duration-200 hover:bg-white/6 hover:text-white" onClick={exportCurrentFile}>
              Export
            </button>
          </div>
        </div>
      </header>

      <main class="min-h-0 flex-1 flex overflow-hidden">
        <aside class="w-[260px] shrink-0 border-r border-[rgba(255,255,255,0.08)] bg-[#141318]">
          <div class="flex h-11 items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-3">
            <div class="text-12-medium uppercase tracking-[0.18em] text-[#8a8595]">Files</div>
          </div>
          <div class="h-[calc(100%-2.75rem)] overflow-auto px-1 py-2 group/filetree">
            <Switch>
              <Match when={file.tree.state("")?.loaded && file.tree.children("").length === 0}>{props.empty()}</Match>
              <Match when={true}>
                <FileTree
                  path=""
                  class="py-1"
                  modified={[...modifiedSet()]}
                  kinds={props.kinds()}
                  active={selectedPath()}
                  onFileClick={(node) => openFile(node.path)}
                />
              </Match>
            </Switch>
          </div>
        </aside>

        <section class="relative min-w-0 flex-1 flex flex-col overflow-hidden bg-[#131217]">
          <Show
            when={selectedPath()}
            fallback={
              <div class="flex h-full items-center justify-center bg-[#131217] px-8 text-center">
                <div class="max-w-sm">
                  <img src="/vector-logo.png" alt="" class="mx-auto mb-5 size-14 rounded-2xl opacity-85" draggable={false} />
                  <div class="text-19-medium text-white">Open a file to start editing.</div>
                  <div class="mt-2 text-13-regular leading-relaxed text-[#a9a4b5]">
                    Vector Codespace is in stable editor mode: file tree, real syntax highlighting, autocomplete, local save, and preview.
                  </div>
                </div>
              </div>
            }
          >
            {(path) => (
              <Switch>
                <Match when={state()?.loaded || drafts[path()] !== undefined}>
                  <Switch>
                    <Match when={activeView() === "editor"}>
                      <div class="flex h-full min-h-0 flex-col overflow-hidden">
                        <div class="flex h-12 shrink-0 items-center justify-between border-b border-[#161519] bg-[#111018] px-4">
                          <div class="min-w-0 flex items-center gap-3">
                            <span class="size-2.5 rounded-full bg-[#9b6cff]" />
                            <span class="truncate font-mono text-14-medium text-white">{path()}</span>
                            <span class={`rounded-xl border px-2.5 py-1 text-11-medium ${activeBadge().ring} ${activeBadge().color}`}>
                              {activeBadge().label}
                            </span>
                            <span class="rounded-xl border border-[rgba(255,255,255,0.10)] bg-[#1b1a21] px-2.5 py-1 text-11-medium text-[#a9a4b5]">
                              {lineCount()} lines
                            </span>
                          </div>
                          <div class="flex items-center gap-2">
                            <span class="text-12-regular text-[#8a8595]">{dirty() ? "Unsaved changes" : "Saved locally"}</span>
                            <button class="rounded-xl border border-[rgba(255,255,255,0.10)] bg-[#1b1a21] px-3 py-1.5 text-12-medium text-[#e2dfe9] transition duration-200 hover:bg-[#211f28]" onClick={copyCurrentFile}>
                              Copy
                            </button>
                          </div>
                        </div>
                        <div class="min-h-0 flex-1 overflow-hidden bg-[#131217]">
                          <VectorCodeEditor path={path()} value={draft()} onChange={(next) => setDrafts(path(), next)} />
                        </div>
                      </div>
                    </Match>
                    <Match when={activeView() === "preview"}>
                      <Show
                        when={previewDocument()}
                        fallback={
                          <div class="flex h-full items-center justify-center bg-[#131217] px-8 text-center">
                            <div class="max-w-md rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#1b1a21] p-6 shadow-[0_18px_50px_rgba(0,0,0,0.28)]">
                              <img src="/vector-logo.png" alt="" class="mx-auto mb-4 size-10 rounded-xl opacity-80" draggable={false} />
                              <div class="text-16-medium text-white">No previewable HTML found.</div>
                              <div class="mt-2 text-13-regular leading-relaxed text-[#a9a4b5]">
                                Open an HTML file, or create one in this workspace, and Vector will render it here.
                              </div>
                            </div>
                          </div>
                        }
                      >
                        {(document) => (
                          <iframe
                            title="Vector Preview"
                            sandbox="allow-scripts allow-forms allow-same-origin"
                            srcdoc={document()}
                            class="h-full w-full border-0 bg-white"
                          />
                        )}
                      </Show>
                    </Match>
                    <Match when={activeView() === "problems"}>
                      <div class="h-full overflow-auto bg-[#131217] p-5">
                        <For
                          each={problems()}
                          fallback={
                            <div class="rounded-2xl border border-emerald-400/20 bg-emerald-500/8 p-4 text-13-regular text-emerald-100">
                              No obvious local problems detected in this file.
                            </div>
                          }
                        >
                          {(problem) => (
                            <div class="mb-3 w-full rounded-2xl border border-[rgba(255,255,255,0.10)] bg-[#161519] p-4 text-left transition duration-200 hover:border-violet-400/35">
                              <div class="flex items-center justify-between gap-3">
                                <div class="text-13-medium text-[#edeaf3]">Line {problem.line}</div>
                                <div
                                  class="rounded-full px-2 py-0.5 text-11-medium uppercase"
                                  classList={{
                                    "bg-red-500/15 text-red-200": problem.severity === "error",
                                    "bg-amber-500/15 text-amber-200": problem.severity === "warning",
                                    "bg-sky-500/15 text-sky-200": problem.severity === "info",
                                  }}
                                >
                                  {problem.severity}
                                </div>
                              </div>
                              <div class="mt-2 text-13-regular text-[#a9a4b5]">{problem.message}</div>
                              <div class="mt-3 flex flex-wrap items-center gap-2">
                                <button
                                  class="rounded-full bg-[#7c3aed] px-3 py-1.5 text-12-medium text-white transition duration-200 hover:bg-[#8b5cf6]"
                                  onClick={() => sendProblemToAgent(problem, "fix")}
                                >
                                  Fix with AI
                                </button>
                                <button
                                  class="rounded-full border border-[rgba(255,255,255,0.12)] px-3 py-1.5 text-12-medium text-[#d6d2df] transition duration-200 hover:bg-white/6"
                                  onClick={() => sendProblemToAgent(problem, "explain")}
                                >
                                  Explain
                                </button>
                                <button
                                  class="rounded-full border border-[rgba(255,255,255,0.12)] px-3 py-1.5 text-12-medium text-[#d6d2df] transition duration-200 hover:bg-white/6"
                                  onClick={() => setActiveView("editor")}
                                >
                                  Go to editor
                                </button>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Match>
                  </Switch>
                </Match>
                <Match when={state()?.loading}>
                  <div class="px-6 py-5 text-13-regular text-[#a9a4b5]">Loading {path()}...</div>
                </Match>
                <Match when={state()?.error}>
                  {(err) => <div class="px-6 py-5 text-13-regular text-[#a9a4b5]">{err()}</div>}
                </Match>
              </Switch>
            )}
          </Show>
        </section>
      </main>
    </div>
  )
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const settings = useSettings()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const sdk = useSDK()
  const local = useLocal()
  const { sessionKey, tabs, view, params } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const shown = settings.visibility.fileTree

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: shown(),
        opened: layout.fileTree.opened(),
      }),
  )
  const open = createMemo(() => reviewOpen() || fileOpen())
  const reviewTab = createMemo(() => isDesktop())
  const codespaceOpen = createMemo(() => reviewOpen() && tabs().active() === "codespace")
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (codespaceOpen()) return "100%"
    if (reviewOpen()) return "auto"
    return `${layout.fileTree.width()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const aiChangeSignature = createMemo(() => diffFiles().join("\u0000"))
  const [archaeologyOpen, setArchaeologyOpen] = createSignal(false)
  const [archaeologyTab, setArchaeologyTab] = createSignal<"timeline" | "review" | "checkpoints" | "health">("timeline")
  const [checkpointRefresh, setCheckpointRefresh] = createSignal(0)
  const [restoringCheckpoint, setRestoringCheckpoint] = createSignal<string | undefined>()
  const [projectReport, setProjectReport] = createSignal<VectorLocalReport | undefined>()
  const [projectReportLoading, setProjectReportLoading] = createSignal(false)
  const aiCheckpoints = createMemo(() => {
    checkpointRefresh()
    return loadAiChangeCheckpoints(sessionKey())
  })
  const engineeringTimeline = createMemo<EngineeringTimelineEntry[]>(() => {
    const checkpoints = aiCheckpoints()
    const checkpointTimeByFile = new Map<string, number>()
    for (const checkpoint of checkpoints) {
      for (const path of checkpoint.files) {
        const previous = checkpointTimeByFile.get(path) ?? 0
        if (checkpoint.createdAt > previous) checkpointTimeByFile.set(path, checkpoint.createdAt)
      }
    }

    const reviewEntries = diffs().map((diff) => {
      const risk = estimateDiffRisk(diff)
      const additions = diff.additions ?? 0
      const deletions = diff.deletions ?? 0
      return {
        id: `review:${diff.file}:${diff.status}:${additions}:${deletions}`,
        createdAt: checkpointTimeByFile.get(diff.file) ?? 0,
        timeLabel: checkpointTimeByFile.has(diff.file) ? undefined : "Pending review",
        kind: "edit" as const,
        title: `${diffActionLabel(diff)} · ${fileBasename(diff.file)}`,
        detail: `${diff.file} has ${additions} added and ${deletions} removed line${additions + deletions === 1 ? "" : "s"}. Risk: ${risk}.`,
        files: [diff.file],
        risk,
        additions,
        deletions,
      } satisfies EngineeringTimelineEntry
    })

    const checkpointEntries = checkpoints.map((checkpoint) => {
      return {
        id: `checkpoint:${checkpoint.id}`,
        createdAt: checkpoint.createdAt,
        kind: "checkpoint" as const,
        title: checkpoint.title,
        detail: checkpoint.documentation || createAiCheckpointDocumentation(checkpoint.files),
        files: checkpoint.files,
        risk: checkpoint.files.length > 4 ? "Medium" : "Low",
      } satisfies EngineeringTimelineEntry
    })

    return [...reviewEntries, ...checkpointEntries].sort((a, b) => {
      const aTime = a.createdAt || Number.MAX_SAFE_INTEGER
      const bTime = b.createdAt || Number.MAX_SAFE_INTEGER
      return bTime - aTime
    })
  })
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  createEffect(
    on(
      aiChangeSignature,
      (signature) => {
        if (!signature) return
        const seenKey = `vector.ai-change-checkpoint.${sessionKey()}`
        if (localStorage.getItem(seenKey) === signature) return
        localStorage.setItem(seenKey, signature)

        const createdAt = Date.now()
        const files = signature.split("\u0000").filter(Boolean)
        void (async () => {
          const snapshots = (
            await Promise.all(
              files.map(async (path) => {
                try {
                  const result = await sdk().client.file.read({ path })
                  const content = textFromFileReadResponse(result)
                  if (!content) return undefined
                  return { path, content } satisfies AiChangeCheckpointSnapshot
                } catch {
                  return undefined
                }
              }),
            )
          ).filter((item): item is AiChangeCheckpointSnapshot => Boolean(item))

          const flagged = snapshots.flatMap((snapshot) =>
            detectSecrets(snapshot.content).map((label) => `${fileBasename(snapshot.path)} (${label})`),
          )
          if (flagged.length > 0) {
            showToast({
              variant: "error",
              title: "Secret scanner: review before accepting",
              description: `AI-modified files may contain credentials: ${[...new Set(flagged)].slice(0, 3).join("; ")}. Keep real keys in environment variables.`,
            })
          }

          const existing = (() => {
            try {
              return JSON.parse(localStorage.getItem(AI_CHANGE_CHECKPOINTS_KEY) ?? "[]") as AiChangeCheckpoint[]
            } catch {
              return []
            }
          })()
          localStorage.setItem(
            AI_CHANGE_CHECKPOINTS_KEY,
            JSON.stringify([
              {
                id: `${sessionKey()}-${createdAt}`,
                session: sessionKey(),
                title: `${files.length} AI-edited ${files.length === 1 ? "file" : "files"}`,
                files,
                createdAt,
                documentation: createAiCheckpointDocumentation(files),
                snapshots,
              },
              ...existing,
            ].slice(0, 80)),
          )
          setCheckpointRefresh((value) => value + 1)
        })()
      },
      { defer: true },
    ),
  )

  const readWorkspaceTextFile = async (path: string) => {
    const result = await sdk().client.file.read({ path })
    return textFromFileReadResponse(result)
  }

  const collectWorkspaceReportFiles = async () => {
    const files: VectorReportFile[] = []
    const maxFiles = 220
    const maxChars = 900_000
    let chars = 0

    const visit = async (dir: string, depth: number): Promise<void> => {
      if (files.length >= maxFiles || chars >= maxChars || depth > 7) return
      const result = await sdk().client.file.list({ path: dir })
      const nodes = result.data ?? []
      const sorted = [...nodes].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.path.localeCompare(b.path)
      })

      for (const node of sorted) {
        if (node.ignored) continue
        const base = reportFileBasename(node.path)
        if (node.type === "directory") {
          if ([".git", "node_modules", "dist", "build", ".next", "coverage", "out", "target", "vendor"].includes(base)) continue
          await visit(node.path, depth + 1)
          continue
        }
        if (!looksLikeTextProjectFile(node.path)) continue
        if (files.length >= maxFiles || chars >= maxChars) break
        try {
          const content = await readWorkspaceTextFile(node.path)
          if (!content) continue
          chars += content.length
          files.push({ path: node.path, content })
        } catch {
          // Binary, missing, or unreadable files are intentionally skipped by the local report.
        }
      }
    }

    await visit("", 0)
    return files
  }

  const runProjectDoctor = async () => {
    setProjectReportLoading(true)
    try {
      const files = await collectWorkspaceReportFiles()
      const model = local.model.current()
      const variant = local.model.variant.current()
      setProjectReport(buildVectorLocalReport(files, diffs(), `${model?.name ?? "No model selected"}${variant ? ` · ${variant}` : ""}`))
      showToast({
        title: "Project Doctor finished",
        description: `Scanned ${files.length} workspace file${files.length === 1 ? "" : "s"} locally.`,
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Project Doctor failed",
        description: error instanceof Error && error.message ? error.message : "Vector could not scan this workspace.",
      })
    } finally {
      setProjectReportLoading(false)
    }
  }

  const openCodeArchaeologyPanel = (event?: Event) => {
    const detail = (event as CustomEvent<{ tab?: "timeline" | "review" | "checkpoints" | "health"; scan?: boolean }> | undefined)?.detail
    setArchaeologyTab(detail?.tab ?? "timeline")
    setArchaeologyOpen(true)
    view().reviewPanel.close()
    layout.fileTree.close()
    if (detail?.scan || detail?.tab === "health") void runProjectDoctor()
  }

  const closeCodeArchaeologyPanel = () => {
    setArchaeologyOpen(false)
  }

  const restoreAiCheckpoint = async (checkpoint: AiChangeCheckpoint) => {
    const snapshots = checkpoint.snapshots ?? []
    if (!snapshots.length) {
      showToast({
        variant: "error",
        title: "Checkpoint cannot be restored",
        description: "This checkpoint was created before Vector started storing restore snapshots.",
      })
      return
    }

    setRestoringCheckpoint(checkpoint.id)
    try {
      for (const snapshot of snapshots) {
        await sdk().client.file.write({ directory: sdk().directory, path: snapshot.path, content: snapshot.content })
        await file.load(snapshot.path, { force: true })
      }
      await file.tree.refresh("")
      showToast({
        title: "Checkpoint restored",
        description: `Restored ${snapshots.length} file${snapshots.length === 1 ? "" : "s"} from ${formatCheckpointTime(checkpoint.createdAt)}.`,
      })
    } catch (error) {
      showToast({
        variant: "error",
        title: "Could not restore checkpoint",
        description: error instanceof Error && error.message ? error.message : "Vector could not write one or more checkpoint files.",
      })
    } finally {
      setRestoringCheckpoint(undefined)
    }
  }

  const openReviewDiffFromArchaeology = (path: string) => {
    closeCodeArchaeologyPanel()
    view().reviewPanel.open("other")
    props.focusReviewDiff(path)
  }

  globalThis.window?.addEventListener("vector:open-code-archaeology", openCodeArchaeologyPanel)
  onCleanup(() => globalThis.window?.removeEventListener("vector:open-code-archaeology", openCodeArchaeologyPanel))

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const contextActive = createMemo(() => activeTab() === "context")

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const closePanel = () => {
    view().reviewPanel.close()
    layout.fileTree.close()
    if (tabs().active() === "context") tabs().close("context")
    if (tabs().active() === "codespace") tabs().close("codespace")
  }

  const openCodespaceTab = () => {
    view().reviewPanel.open("other")
    layout.fileTree.close()
    void tabs().open("codespace")
    tabs().setActive("codespace")
  }

  const handleTabChange = (value: string) => {
    if (value === "codespace") {
      openCodespaceTab()
      return
    }
    openTab(value)
  }

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open()) return
    event.preventDefault()
    closePanel()
  }

  globalThis.window?.addEventListener("keydown", handleKeydown, { capture: true })
  onCleanup(() => globalThis.window?.removeEventListener("keydown", handleKeydown, { capture: true }))

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <>
    <Show when={isDesktop() && !(settings.general.newLayoutDesigns() && !params.id)}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
          "rounded-[10px] shadow-[var(--v2-elevation-raised)] overflow-hidden": settings.general.newLayoutDesigns() && !codespaceOpen(),
          "flex-1": reviewOpen(),
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={open()}>
          <div
            class="size-full flex"
            classList={{
              "border-l border-border-weaker-base": !settings.general.newLayoutDesigns() && !codespaceOpen(),
            }}
          >
            <div
              aria-hidden={!reviewOpen()}
              inert={!reviewOpen()}
              class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
              classList={{
                "pointer-events-none": !reviewOpen(),
              }}
            >
              <div class="size-full min-w-0 h-full bg-background-base">
                <DragDropProvider
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  collisionDetector={closestCenter}
                >
                  <DragDropSensors />
                  <ConstrainDragYAxis />
                  <Tabs value={activeTab()} onChange={handleTabChange}>
                    <Show when={activeTab() !== "codespace"}>
                      <Show
                        when={contextActive()}
                        fallback={
                        <div class="sticky top-0 shrink-0 flex">
                          <Tabs.List
                            ref={(el: HTMLDivElement) => {
                              const stop = createFileTabListSync({ el, contextOpen })
                              onCleanup(stop)
                            }}
                          >
                        <Show when={contextOpen()}>
                          <Tabs.Trigger
                            value="context"
                            closeButton={
                              <TooltipKeybind
                                title={language.t("common.closeTab")}
                                keybind={command.keybind("tab.close")}
                                placement="bottom"
                                gutter={10}
                              >
                                <IconButton
                                  icon="close-small"
                                  variant="ghost"
                                  class="h-5 w-5"
                                  onClick={() => tabs().close("context")}
                                  aria-label={language.t("common.closeTab")}
                                />
                              </TooltipKeybind>
                            }
                            hideCloseButton
                            onMiddleClick={() => tabs().close("context")}
                          >
                            <div class="flex items-center gap-2">
                              <SessionContextUsage variant="indicator" />
                              <div>{language.t("session.tab.context")}</div>
                            </div>
                          </Tabs.Trigger>
                        </Show>
                        <Show when={reviewTab() && props.canReview()}>
                          <Tabs.Trigger value="review">
                            <div class="flex items-center gap-1.5">
                              <div>Changes</div>
                              <Show when={props.hasReview()}>
                                <div>{props.reviewCount()}</div>
                              </Show>
                            </div>
                          </Tabs.Trigger>
                        </Show>
                        <SortableProvider ids={openedTabs()}>
                          <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                        </SortableProvider>
                        <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
                          <TooltipKeybind title="Close panel" keybind="Esc" placement="bottom" gutter={10}>
                            <IconButton
                              icon="close-small"
                              variant="ghost"
                              iconSize="large"
                              class="!rounded-md"
                              onClick={closePanel}
                              aria-label="Close review panel"
                            />
                          </TooltipKeybind>
                        </div>
                          </Tabs.List>
                        </div>
                        }
                      >
                        <div class="sticky top-0 z-20 h-10 shrink-0 flex items-center justify-between border-b border-border-weaker-base bg-background-stronger px-3">
                          <div class="flex min-w-0 items-center gap-2 text-12-medium text-text-base">
                            <SessionContextUsage variant="indicator" />
                            <span>Context</span>
                          </div>
                          <TooltipKeybind title="Close context" keybind="Esc" placement="bottom" gutter={10}>
                            <IconButton
                              icon="close-small"
                              variant="ghost"
                              iconSize="large"
                              class="!rounded-md"
                              onClick={() => {
                                tabs().close("context")
                                view().reviewPanel.close()
                              }}
                              aria-label="Close context"
                            />
                          </TooltipKeybind>
                        </div>
                      </Show>
                    </Show>

                    <Show when={reviewTab() && props.canReview()}>
                      <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={reviewOpen() && activeTab() === "review"}>{props.reviewPanel()}</Show>
                      </Tabs.Content>
                    </Show>

                    <Tabs.Content value="codespace" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={reviewOpen() && activeTab() === "codespace"}>
                        <StableCodespaceWorkbench
                          modified={diffFiles}
                          kinds={kinds}
                          empty={() => empty(language.t("session.files.empty"))}
                          diffs={diffs}
                          focusReviewDiff={props.focusReviewDiff}
                          sessionKey={sessionKey}
                          onClose={closePanel}
                        />
                      </Show>
                    </Tabs.Content>

                    <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                      <Show when={activeTab() === "empty"}>
                        <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                          <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                            <Mark class="w-14 opacity-10" />
                            <div class="text-14-regular text-text-weak max-w-56">
                              {language.t("session.files.selectToOpen")}
                            </div>
                          </div>
                        </div>
                      </Show>
                    </Tabs.Content>

                    <Show when={contextOpen()}>
                      <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "context"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                            <SessionContextTab />
                          </div>
                        </Show>
                      </Tabs.Content>
                    </Show>

                    <Show when={activeFileTab()} keyed>
                      {(tab) => <FileTabContent tab={tab} />}
                    </Show>
                  </Tabs>
                  <DragOverlay>
                    <Show when={store.activeDraggable} keyed>
                      {(tab) => {
                        const path = file.pathFromTab(tab)
                        return (
                          <div data-component="tabs-drag-preview">
                            <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                          </div>
                        )
                      }}
                    </Show>
                  </DragOverlay>
                </DragDropProvider>
              </div>
            </div>

            <Show when={shown()}>
              <div
                id="file-tree-panel"
                aria-hidden={!fileOpen()}
                inert={!fileOpen()}
                class="relative min-w-0 h-full shrink-0 overflow-hidden"
                classList={{
                  "pointer-events-none": !fileOpen(),
                  "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                    !props.size.active(),
                }}
                style={{ width: treeWidth() }}
              >
                <div
                  class="h-full flex flex-col overflow-hidden group/filetree"
                  classList={{ "border-l border-border-weaker-base": reviewOpen() }}
                >
                  <Tabs
                    variant="pill"
                    value={fileTreeTab()}
                    onChange={setFileTreeTabValue}
                    class="h-full"
                    data-scope="filetree"
                  >
                    <Tabs.List>
                      <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                        {props.reviewCount()}{" "}
                        {language.t(
                          props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                        )}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                        {language.t("session.files.all")}
                      </Tabs.Trigger>
                    </Tabs.List>
                    <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                      <Switch>
                        <Match when={props.hasReview() || !props.diffsReady()}>
                          <Show
                            when={props.diffsReady()}
                            fallback={
                              <div class="px-2 py-2 text-12-regular text-text-weak">
                                {language.t("common.loading")}
                                {language.t("common.loading.ellipsis")}
                              </div>
                            }
                          >
                            <FileTree
                              path=""
                              class="pt-3"
                              allowed={diffFiles()}
                              kinds={kinds()}
                              draggable={false}
                              active={props.activeDiff}
                              onFileClick={(node) => props.focusReviewDiff(node.path)}
                            />
                          </Show>
                        </Match>
                      </Switch>
                    </Tabs.Content>
                    <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                      <Switch>
                        <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                        <Match when={true}>
                          <FileTree
                            path=""
                            class="pt-3"
                            modified={diffFiles()}
                            kinds={kinds()}
                            onFileClick={(node) => openTab(file.tab(node.path))}
                          />
                        </Match>
                      </Switch>
                    </Tabs.Content>
                  </Tabs>
                </div>
                <Show when={fileOpen()}>
                  <div onPointerDown={() => props.size.start()}>
                    <ResizeHandle
                      direction="horizontal"
                      edge="start"
                      size={layout.fileTree.width()}
                      min={200}
                      max={typeof window === "undefined" ? 1200 : Math.max(720, window.innerWidth * 0.72)}
                      onResize={(width) => {
                        props.size.touch()
                        layout.fileTree.resize(width)
                      }}
                    />
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </aside>
    </Show>
    <Show when={isDesktop() && archaeologyOpen()}>
      <aside
        class="fixed bottom-4 right-4 top-4 z-[70] flex w-[min(600px,calc(100vw-120px))] flex-col overflow-hidden rounded-[28px] border border-[#34283f] bg-[#121116]/98 text-white shadow-[0_28px_90px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
        aria-label="Code Archaeology"
      >
        <header class="flex h-20 shrink-0 items-center justify-between border-b border-[#28232f] px-5">
          <div class="min-w-0">
            <div class="text-17-medium">Code Archaeology</div>
            <div class="mt-1 text-12-regular text-white/48">Review every AI edit and restore documented checkpoints.</div>
          </div>
          <button
            type="button"
            class="grid size-9 place-items-center rounded-full text-white/46 transition duration-200 hover:bg-white/[0.07] hover:text-white"
            aria-label="Close Code Archaeology"
            onClick={closeCodeArchaeologyPanel}
          >
            ×
          </button>
        </header>

        <div class="grid grid-cols-4 gap-2 border-b border-[#28232f] p-3">
          <button
            type="button"
            class="rounded-2xl px-3 py-3 text-13-medium transition duration-200"
            classList={{
              "bg-[#8b5cf6] text-white shadow-[0_16px_38px_rgba(139,92,246,0.22)]": archaeologyTab() === "timeline",
              "bg-white/[0.04] text-white/58 hover:bg-white/[0.07] hover:text-white": archaeologyTab() !== "timeline",
            }}
            onClick={() => setArchaeologyTab("timeline")}
          >
            Timeline
            <Show when={engineeringTimeline().length}>
              <span class="ml-2 rounded-full bg-white/18 px-2 py-0.5 text-[10px]">{engineeringTimeline().length}</span>
            </Show>
          </button>
          <button
            type="button"
            class="rounded-2xl px-3 py-3 text-13-medium transition duration-200"
            classList={{
              "bg-[#8b5cf6] text-white shadow-[0_16px_38px_rgba(139,92,246,0.22)]": archaeologyTab() === "review",
              "bg-white/[0.04] text-white/58 hover:bg-white/[0.07] hover:text-white": archaeologyTab() !== "review",
            }}
            onClick={() => setArchaeologyTab("review")}
          >
            Review all changes
            <Show when={diffs().length}>
              <span class="ml-2 rounded-full bg-white/18 px-2 py-0.5 text-[10px]">{diffs().length}</span>
            </Show>
          </button>
          <button
            type="button"
            class="rounded-2xl px-3 py-3 text-13-medium transition duration-200"
            classList={{
              "bg-[#8b5cf6] text-white shadow-[0_16px_38px_rgba(139,92,246,0.22)]": archaeologyTab() === "checkpoints",
              "bg-white/[0.04] text-white/58 hover:bg-white/[0.07] hover:text-white": archaeologyTab() !== "checkpoints",
            }}
            onClick={() => setArchaeologyTab("checkpoints")}
          >
            Checkpoints
            <Show when={aiCheckpoints().length}>
              <span class="ml-2 rounded-full bg-white/18 px-2 py-0.5 text-[10px]">{aiCheckpoints().length}</span>
            </Show>
          </button>
          <button
            type="button"
            class="rounded-2xl px-3 py-3 text-13-medium transition duration-200"
            classList={{
              "bg-[#8b5cf6] text-white shadow-[0_16px_38px_rgba(139,92,246,0.22)]": archaeologyTab() === "health",
              "bg-white/[0.04] text-white/58 hover:bg-white/[0.07] hover:text-white": archaeologyTab() !== "health",
            }}
            onClick={() => {
              setArchaeologyTab("health")
              void runProjectDoctor()
            }}
          >
            Project Doctor
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-auto p-4">
          <Switch>
            <Match when={archaeologyTab() === "timeline"}>
              <For
                each={engineeringTimeline()}
                fallback={
                  <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5 text-13-regular leading-relaxed text-white/56">
                    No engineering events yet. When Vector creates reviewable AI edits, the timeline will show what changed, the risk level, and the checkpoint record.
                  </div>
                }
              >
                {(entry) => (
                  <div class="relative mb-4 pl-8">
                    <div
                      class="absolute left-1 top-1 grid size-5 place-items-center rounded-full border"
                      classList={{
                        "border-emerald-300/35 bg-emerald-400/12 text-emerald-200": entry.kind === "checkpoint",
                        "border-violet-300/35 bg-violet-400/12 text-violet-100": entry.kind === "edit",
                        "border-sky-300/35 bg-sky-400/12 text-sky-100": entry.kind === "review",
                      }}
                    >
                      <span class="text-[10px]">{entry.kind === "checkpoint" ? "✓" : "•"}</span>
                    </div>
                    <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-4">
                      <div class="flex items-start justify-between gap-4">
                        <div class="min-w-0">
                          <div class="text-14-medium text-white">{entry.title}</div>
                          <div class="mt-1 text-11-regular text-white/42">
                            {entry.timeLabel || formatCheckpointTime(entry.createdAt)}
                          </div>
                        </div>
                        <Show when={entry.risk}>
                          {(risk) => (
                            <div
                              class="shrink-0 rounded-full border px-2.5 py-1 text-10-medium uppercase tracking-[0.12em]"
                              classList={{
                                "border-emerald-300/20 bg-emerald-500/10 text-emerald-200": risk() === "Low",
                                "border-amber-300/20 bg-amber-500/10 text-amber-200": risk() === "Medium",
                                "border-red-300/20 bg-red-500/10 text-red-200": risk() === "High",
                              }}
                            >
                              {risk()} risk
                            </div>
                          )}
                        </Show>
                      </div>
                      <div class="mt-3 text-13-regular leading-relaxed text-white/62">{entry.detail}</div>
                      <Show when={entry.additions !== undefined || entry.deletions !== undefined}>
                        <div class="mt-3 font-mono text-12-medium">
                          <span class="text-emerald-300">+{entry.additions ?? 0}</span>{" "}
                          <span class="text-red-300">-{entry.deletions ?? 0}</span>
                        </div>
                      </Show>
                      <div class="mt-4 flex flex-wrap gap-2">
                        <For each={entry.files}>
                          {(filePath) => (
                            <button
                              type="button"
                              class="rounded-full border border-white/[0.1] bg-black/18 px-3 py-1.5 font-mono text-11-medium text-white/64 transition duration-200 hover:border-[#8b5cf6]/45 hover:text-white"
                              onClick={() => openReviewDiffFromArchaeology(filePath)}
                            >
                              {filePath}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </Match>

            <Match when={archaeologyTab() === "review"}>
              <For
                each={diffs()}
                fallback={
                  <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5 text-13-regular leading-relaxed text-white/56">
                    No AI-edited files are waiting for review yet. When the Vector agent changes files, they will appear here before you inspect them in the review panel.
                  </div>
                }
              >
                {(diff) => (
                  <button
                    type="button"
                    class="mb-3 w-full rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-4 text-left transition duration-200 hover:border-[#8b5cf6]/45 hover:bg-white/[0.06]"
                    onClick={() => openReviewDiffFromArchaeology(diff.file)}
                  >
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0">
                        <div class="truncate font-mono text-13-medium text-white">{diff.file}</div>
                        <div class="mt-2 text-12-regular text-white/44">Open this file in the normal review diff.</div>
                      </div>
                      <div class="shrink-0 text-right">
                        <div class="rounded-full border border-white/[0.1] bg-black/24 px-2.5 py-1 text-10-medium uppercase tracking-[0.12em] text-white/56">
                          {diff.status}
                        </div>
                        <div class="mt-2 font-mono text-12-medium">
                          <span class="text-emerald-300">+{diff.additions}</span>{" "}
                          <span class="text-red-300">-{diff.deletions}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                )}
              </For>
            </Match>

            <Match when={archaeologyTab() === "checkpoints"}>
              <For
                each={aiCheckpoints()}
                fallback={
                  <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5 text-13-regular leading-relaxed text-white/56">
                    No AI checkpoints yet. Vector creates a checkpoint whenever the chat agent produces file edits for this session.
                  </div>
                }
              >
                {(checkpoint, index) => (
                  <div class="mb-4 rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5">
                    <div class="flex items-start justify-between gap-4">
                      <div class="min-w-0">
                        <div class="text-14-medium text-white">{checkpoint.title}</div>
                        <div class="mt-1 text-12-regular text-white/44">
                          {index() === 0 ? "Latest checkpoint" : `Checkpoint ${aiCheckpoints().length - index()}`} · {formatCheckpointTime(checkpoint.createdAt)}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="shrink-0 rounded-full border border-[#8b5cf6]/35 bg-[#8b5cf6]/12 px-3 py-1.5 text-12-medium text-violet-100 transition duration-200 hover:bg-[#8b5cf6]/22 disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={restoringCheckpoint() === checkpoint.id}
                        onClick={() => void restoreAiCheckpoint(checkpoint)}
                      >
                        {restoringCheckpoint() === checkpoint.id ? "Restoring..." : "Restore"}
                      </button>
                    </div>
                    <div class="mt-4 rounded-[18px] border border-white/[0.07] bg-black/22 p-4 text-13-regular leading-relaxed text-white/66">
                      {checkpoint.documentation || createAiCheckpointDocumentation(checkpoint.files)}
                    </div>
                    <div class="mt-4 flex flex-wrap gap-2">
                      <For each={checkpoint.files}>
                        {(filePath) => (
                          <button
                            type="button"
                            class="rounded-full border border-white/[0.1] bg-white/[0.045] px-3 py-1.5 font-mono text-11-medium text-white/64 transition duration-200 hover:border-[#8b5cf6]/45 hover:text-white"
                            onClick={() => openReviewDiffFromArchaeology(filePath)}
                          >
                            {filePath}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
            </Match>

            <Match when={archaeologyTab() === "health"}>
              <div class="space-y-4">
                <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5">
                  <div class="flex items-start justify-between gap-4">
                    <div>
                      <div class="text-15-medium text-white">Local Project Doctor</div>
                      <div class="mt-1 text-12-regular text-white/48">
                        Real workspace scan: preview readiness, file health, context risk, project memory, and demo checklist.
                      </div>
                    </div>
                    <button
                      type="button"
                      class="shrink-0 rounded-full bg-[#8b5cf6] px-4 py-2 text-12-medium text-white transition duration-200 hover:bg-[#9b6cff] disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={projectReportLoading()}
                      onClick={() => void runProjectDoctor()}
                    >
                      {projectReportLoading() ? "Scanning..." : "Scan now"}
                    </button>
                  </div>
                </div>

                <Show
                  when={projectReport()}
                  fallback={
                    <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5 text-13-regular leading-relaxed text-white/56">
                      Click Scan now to inspect the actual workspace. Vector will not call the model and will not edit files.
                    </div>
                  }
                >
                  {(report) => (
                    <>
                      <div class="grid grid-cols-3 gap-3">
                        <div class="rounded-[22px] border border-white/[0.08] bg-black/20 p-4">
                          <div class="text-10-medium uppercase tracking-[0.16em] text-white/38">Files</div>
                          <div class="mt-2 text-22-medium text-white">{report().fileCount}</div>
                        </div>
                        <div class="rounded-[22px] border border-white/[0.08] bg-black/20 p-4">
                          <div class="text-10-medium uppercase tracking-[0.16em] text-white/38">Lines</div>
                          <div class="mt-2 text-22-medium text-white">{report().lineCount.toLocaleString()}</div>
                        </div>
                        <div class="rounded-[22px] border border-white/[0.08] bg-black/20 p-4">
                          <div class="text-10-medium uppercase tracking-[0.16em] text-white/38">Context</div>
                          <div
                            class="mt-2 text-22-medium"
                            classList={{
                              "text-emerald-200": report().cost.risk === "Low",
                              "text-amber-200": report().cost.risk === "Medium",
                              "text-red-200": report().cost.risk === "High",
                            }}
                          >
                            {report().cost.risk}
                          </div>
                        </div>
                      </div>

                      <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5">
                        <div class="flex items-center justify-between gap-3">
                          <div>
                            <div class="text-14-medium text-white">Preview Doctor</div>
                            <div class="mt-1 text-12-regular text-white/45">{report().preview.title}</div>
                          </div>
                          <div
                            class="rounded-full border px-3 py-1 text-10-medium uppercase tracking-[0.13em]"
                            classList={{
                              "border-emerald-300/20 bg-emerald-500/10 text-emerald-200": report().preview.status === "ready",
                              "border-amber-300/20 bg-amber-500/10 text-amber-200": report().preview.status === "warning",
                              "border-red-300/20 bg-red-500/10 text-red-200": report().preview.status === "blocked",
                            }}
                          >
                            {report().preview.status}
                          </div>
                        </div>
                        <ul class="mt-4 space-y-2 text-13-regular text-white/62">
                          <For each={report().preview.details}>{(item) => <li>• {item}</li>}</For>
                        </ul>
                      </div>

                      <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5">
                        <div class="text-14-medium text-white">Project Memory</div>
                        <div class="mt-2 text-13-regular leading-relaxed text-white/62">{report().memory.summary}</div>
                        <div class="mt-4 flex flex-wrap gap-2">
                          <For each={report().frameworks}>
                            {(item) => <span class="rounded-full border border-violet-300/15 bg-violet-400/10 px-3 py-1 text-11-medium text-violet-100">{item}</span>}
                          </For>
                        </div>
                        <div class="mt-4 grid gap-4 md:grid-cols-2">
                          <div>
                            <div class="text-11-medium uppercase tracking-[0.16em] text-white/36">Important files</div>
                            <div class="mt-2 space-y-1">
                              <For each={report().memory.importantFiles}>
                                {(item) => <div class="truncate font-mono text-11-regular text-white/58">{item}</div>}
                              </For>
                            </div>
                          </div>
                          <div>
                            <div class="text-11-medium uppercase tracking-[0.16em] text-white/36">Next safe steps</div>
                            <div class="mt-2 space-y-1 text-12-regular text-white/58">
                              <For each={report().memory.nextSteps}>{(item) => <div>• {item}</div>}</For>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5">
                        <div class="text-14-medium text-white">BYOK Cost Guard</div>
                        <div class="mt-2 text-13-regular text-white/62">
                          Estimated context: {report().cost.estimatedTokens.toLocaleString()} tokens. This is a local estimate, not a billing charge.
                        </div>
                        <ul class="mt-4 space-y-2 text-13-regular text-white/62">
                          <For each={report().cost.guidance}>{(item) => <li>• {item}</li>}</For>
                        </ul>
                      </div>

                      <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5">
                        <div class="text-14-medium text-white">Prompt Quality Guard</div>
                        <div class="mt-2 text-13-medium text-violet-100">{report().promptGuard.verdict}</div>
                        <ul class="mt-4 space-y-2 text-13-regular text-white/62">
                          <For each={report().promptGuard.suggestions}>{(item) => <li>• {item}</li>}</For>
                        </ul>
                      </div>

                      <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5">
                        <div class="text-14-medium text-white">Problems</div>
                        <For
                          each={report().problems}
                          fallback={<div class="mt-3 text-13-regular text-white/54">No local problems detected by the scan.</div>}
                        >
                          {(problem) => (
                            <div class="mt-3 rounded-[18px] border border-white/[0.07] bg-black/20 p-3">
                              <div
                                class="text-11-medium uppercase tracking-[0.14em]"
                                classList={{
                                  "text-red-200": problem.severity === "error",
                                  "text-amber-200": problem.severity === "warning",
                                  "text-sky-200": problem.severity === "info",
                                }}
                              >
                                {problem.severity}
                              </div>
                              <div class="mt-1 font-mono text-11-regular text-white/48">{problem.path}</div>
                              <div class="mt-2 text-13-regular text-white/68">{problem.message}</div>
                            </div>
                          )}
                        </For>
                      </div>

                      <div class="rounded-[24px] border border-white/[0.08] bg-white/[0.035] p-5">
                        <div class="text-14-medium text-white">Demo Mode Checklist</div>
                        <ul class="mt-4 space-y-2 text-13-regular text-white/62">
                          <For each={report().demoChecklist}>{(item) => <li>• {item}</li>}</For>
                        </ul>
                      </div>
                    </>
                  )}
                </Show>
              </div>
            </Match>
          </Switch>
        </div>
      </aside>
    </Show>
    </>
  )
}
