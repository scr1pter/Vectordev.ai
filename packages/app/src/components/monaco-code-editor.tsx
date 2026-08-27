import { createEffect, onCleanup, onMount } from "solid-js"
import * as monaco from "monaco-editor"
import { activeAttributions, type AgentAttribution } from "./editor-attribution"
import { useSettings } from "@/context/settings"
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker"
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker"
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker"
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker"
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker"

// VS Code's actual editor component (Monaco), themed to Vector's charcoal
// ramp. This is the same engine VS Code ships — intellisense, multi-cursor,
// minimap, find/replace, command palette — without forking the application.

export type InlineCompleteInput = {
  path: string
  prefix: string
  suffix: string
  language: string
  cursorLine: number
}
export type InlineCompleteFn = (input: InlineCompleteInput) => Promise<string | undefined>
export type InlineEditSelection = {
  startOffset: number
  endOffset: number
  startLine: number
  endLine: number
  text: string
}

type LanguagePosition = {
  line: number
  character: number
}

type LanguageRange = {
  start: LanguagePosition
  end: LanguagePosition
}

export type MonacoLanguageDiagnostic = {
  range: LanguageRange
  severity?: number
  code?: string
  source?: string
  message: string
}

export type MonacoLanguageLocation = {
  uri: string
  range: LanguageRange
}

export type MonacoLanguageHover = {
  contents: string[]
  range?: LanguageRange
}

export type MonacoLanguageSymbol = {
  name: string
  detail?: string
  kind: number
  range?: LanguageRange
  selectionRange?: LanguageRange
  location?: MonacoLanguageLocation
}

export type MonacoLanguageFileEdit = {
  uri: string
  edits: {
    range: LanguageRange
    newText: string
  }[]
}

export type MonacoLanguageService = {
  diagnostics: (file: string) => Promise<MonacoLanguageDiagnostic[]>
  hover: (file: string, position: LanguagePosition) => Promise<MonacoLanguageHover | undefined>
  definition: (file: string, position: LanguagePosition) => Promise<MonacoLanguageLocation[]>
  references: (file: string, position: LanguagePosition) => Promise<MonacoLanguageLocation[]>
  symbols: (file: string) => Promise<MonacoLanguageSymbol[]>
  rename: (file: string, position: LanguagePosition, newName: string) => Promise<MonacoLanguageFileEdit[]>
  readFile: (file: string) => Promise<string>
  writeFile: (file: string, content: string) => Promise<void>
  filesChanged?: (files: string[]) => Promise<void>
}

let environmentReady = false

// Cursor-style inline (ghost-text) AI completions. Monaco resolves providers by
// model, so we register ONE global provider and route each model's request to the
// editor instance that owns it via this registry (keyed by model URI).
const completionRegistry = new Map<string, InlineCompleteFn>()
const languageServiceRegistry = new Map<string, MonacoLanguageService>()
let inlineProviderReady = false
let languageProvidersReady = false

function languagePosition(position: monaco.Position): LanguagePosition {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  }
}

function monacoRange(range: LanguageRange) {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  )
}

function locationUri(uri: string) {
  if (uri.startsWith("file:")) return monaco.Uri.parse(uri)
  return monaco.Uri.file(uri)
}

async function loadLocation(service: MonacoLanguageService, location: MonacoLanguageLocation) {
  const uri = locationUri(location.uri)
  if (!monaco.editor.getModel(uri)) {
    const content = await service.readFile(uri.fsPath)
    monaco.editor.createModel(content, undefined, uri)
  }
  return {
    uri,
    range: monacoRange(location.range),
  }
}

async function applyRenameEdits(service: MonacoLanguageService, edits: MonacoLanguageFileEdit[]) {
  const changed = await Promise.all(
    edits.map(async (file) => {
      const uri = locationUri(file.uri)
      const model =
        monaco.editor.getModel(uri) ??
        monaco.editor.createModel(await service.readFile(uri.fsPath), undefined, uri)
      model.pushEditOperations(
        [],
        file.edits.map((edit) => ({
          range: monacoRange(edit.range),
          text: edit.newText,
          forceMoveMarkers: true,
        })),
        () => null,
      )
      await service.writeFile(uri.fsPath, model.getValue())
      return uri.fsPath
    }),
  )
  await service.filesChanged?.(changed)
}

function ensureLanguageProviders() {
  if (languageProvidersReady) return
  languageProvidersReady = true

  monaco.languages.registerHoverProvider(
    { pattern: "**" },
    {
      provideHover: async (model, position) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return
        const result = await service.hover(model.uri.fsPath, languagePosition(position)).catch(() => undefined)
        if (!result?.contents.length) return
        return {
          contents: result.contents.map((value) => ({ value })),
          range: result.range ? monacoRange(result.range) : undefined,
        }
      },
    },
  )

  monaco.languages.registerDefinitionProvider(
    { pattern: "**" },
    {
      provideDefinition: async (model, position) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return []
        const locations = await service
          .definition(model.uri.fsPath, languagePosition(position))
          .catch(() => [])
        return Promise.all(locations.map((location) => loadLocation(service, location)))
      },
    },
  )

  monaco.languages.registerReferenceProvider(
    { pattern: "**" },
    {
      provideReferences: async (model, position) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return []
        const locations = await service
          .references(model.uri.fsPath, languagePosition(position))
          .catch(() => [])
        return Promise.all(locations.map((location) => loadLocation(service, location)))
      },
    },
  )

  monaco.languages.registerDocumentSymbolProvider(
    { pattern: "**" },
    {
      provideDocumentSymbols: async (model) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return []
        const symbols = await service.symbols(model.uri.fsPath).catch(() => [])
        return symbols.flatMap((symbol) => {
          const range = symbol.range ?? symbol.location?.range
          const selectionRange = symbol.selectionRange ?? range
          if (!range || !selectionRange) return []
          return [
            {
              name: symbol.name,
              detail: symbol.detail ?? "",
              kind: symbol.kind as monaco.languages.SymbolKind,
              range: monacoRange(range),
              selectionRange: monacoRange(selectionRange),
              tags: [],
            },
          ]
        })
      },
    },
  )

  monaco.languages.registerRenameProvider(
    { pattern: "**" },
    {
      provideRenameEdits: async (model, position, newName) => {
        const service = languageServiceRegistry.get(model.uri.toString())
        if (!service) return { edits: [] }
        await service.writeFile(model.uri.fsPath, model.getValue())
        const edits = await service.rename(model.uri.fsPath, languagePosition(position), newName)
        await applyRenameEdits(service, edits)
        return { edits: [] }
      },
    },
  )
}

function ensureInlineProvider() {
  if (inlineProviderReady) return
  inlineProviderReady = true
  monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" },
    {
      provideInlineCompletions: async (model, position, _context, token) => {
        const complete = completionRegistry.get(model.uri.toString())
        if (!complete) return { items: [] }
        // Debounce: only ask the model once the user pauses; bail if they kept typing.
        await new Promise((resolve) => setTimeout(resolve, 400))
        if (token.isCancellationRequested) return { items: [] }
        const prefix = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column))
        const lastLine = model.getLineCount()
        const suffix = model.getValueInRange(
          new monaco.Range(position.lineNumber, position.column, lastLine, model.getLineMaxColumn(lastLine)),
        )
        const suggestion = await complete({
          path: model.uri.fsPath,
          prefix,
          suffix,
          language: model.getLanguageId(),
          cursorLine: position.lineNumber,
        }).catch(() => undefined)
        if (!suggestion || token.isCancellationRequested) return { items: [] }
        return {
          items: [
            {
              insertText: suggestion,
              range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
            },
          ],
        }
      },
      disposeInlineCompletions: () => {},
    },
  )
}

function ensureMonacoEnvironment() {
  if (environmentReady) return
  environmentReady = true
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === "json") return new jsonWorker()
      if (label === "css" || label === "scss" || label === "less") return new cssWorker()
      if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker()
      if (label === "typescript" || label === "javascript") return new tsWorker()
      return new editorWorker()
    },
  }
  // Vector's editor is backed by the repository LSP below, which resolves the
  // workspace tsconfig, package graph, and aliases. Monaco's standalone worker
  // sees only one open model and otherwise paints valid imports and JSX red.
  // Keep its completions and syntax services, but let the workspace LSP own
  // diagnostics so users see the same result as the repository toolchain.
  const diagnostics = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }
  const typescript = monaco.languages.typescript as unknown as {
    typescriptDefaults: { setDiagnosticsOptions: (options: typeof diagnostics) => void }
    javascriptDefaults: { setDiagnosticsOptions: (options: typeof diagnostics) => void }
  }
  typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics)
  typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics)
  monaco.editor.defineTheme("vector-dark", {
    base: "vs-dark",
    inherit: true,
    // Keep syntax expressive while the editor chrome stays neutral and mature.
    rules: [
      { token: "comment", foreground: "6f5f96", fontStyle: "italic" },
      { token: "keyword", foreground: "b18aff" },
      { token: "string", foreground: "f5a3e0" },
      { token: "number", foreground: "9ff0c8" },
      { token: "regexp", foreground: "ff9ab8" },
      { token: "type", foreground: "82e8e0" },
      { token: "class", foreground: "82e8e0" },
      { token: "function", foreground: "d0b8ff" },
      { token: "variable", foreground: "c7d6ff" },
      { token: "constant", foreground: "b18aff" },
      { token: "operator", foreground: "9d8fc0" },
      { token: "delimiter", foreground: "9d8fc0" },
      { token: "tag", foreground: "b18aff" },
      { token: "attribute.name", foreground: "c7d6ff" },
      { token: "attribute.value", foreground: "f5a3e0" },
      { token: "string.key.json", foreground: "c7d6ff" },
      { token: "string.value.json", foreground: "f5a3e0" },
      { token: "keyword.json", foreground: "b18aff" },
      { token: "number.json", foreground: "9ff0c8" },
    ],
    colors: {
      "editor.background": "#111111",
      "editor.foreground": "#dedede",
      "editorGutter.background": "#111111",
      "editorLineNumber.foreground": "#626262",
      "editorLineNumber.activeForeground": "#bdbdbd",
      "editor.lineHighlightBackground": "#1b1b1b",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#4b2f8f80",
      "editor.inactiveSelectionBackground": "#40335f59",
      "editor.selectionHighlightBackground": "#40335f4d",
      "editorCursor.foreground": "#c9b0ff",
      "editorIndentGuide.background1": "#282828",
      "editorIndentGuide.activeBackground1": "#555555",
      "editorWhitespace.foreground": "#303030",
      "editorWidget.background": "#191919",
      "editorWidget.border": "#383838",
      "editorHoverWidget.background": "#191919",
      "editorHoverWidget.border": "#383838",
      "editorSuggestWidget.background": "#191919",
      "editorSuggestWidget.border": "#383838",
      "editorSuggestWidget.selectedBackground": "#292929",
      "editorGhostText.foreground": "#6f6f6f",
      "editorBracketMatch.background": "#00000000",
      "editorBracketMatch.border": "#7c5ce6",
      "minimap.background": "#111111",
      "editorStickyScroll.background": "#111111",
      "editorStickyScrollHover.background": "#1b1b1b",
      "editorOverviewRuler.border": "#00000000",
      "scrollbarSlider.background": "#ffffff20",
      "scrollbarSlider.hoverBackground": "#ffffff32",
      "scrollbarSlider.activeBackground": "#ffffff46",
    },
  })
}

function modelFor(path: string, value: string) {
  const uri = monaco.Uri.file(path || "untitled.txt")
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    if (existing.getValue() !== value) existing.setValue(value)
    return existing
  }
  return monaco.editor.createModel(value, undefined, uri)
}


const cssId = (value: string) => value.replace(/[^a-z0-9_-]/gi, "")

// Monaco decorations take class names, not inline colours, so each agent's
// colour is injected as a rule once and reused.
let attributionStyleEl: HTMLStyleElement | undefined
function attributionStyles(entries: readonly AgentAttribution[]) {
  if (!entries.length) return
  attributionStyleEl ??= (() => {
    const el = document.createElement("style")
    el.dataset.vectorAgentAttribution = "true"
    document.head.appendChild(el)
    return el
  })()
  attributionStyleEl.textContent = entries
    .map((entry) => {
      const id = cssId(entry.agentId)
      return [
        `.vector-agent-gutter.vector-agent-${id}{border-left:2px solid ${entry.color};margin-left:2px}`,
        `.vector-agent-line.vector-agent-${id}{background:${entry.color}14}`,
      ].join("")
    })
    .join("")
}

export function MonacoCodeEditor(props: {
  path: string
  value: string
  /** Agents whose recent edits should be attributed in the gutter and margin. */
  attributions?: AgentAttribution[]
  onChange: (next: string) => void
  onSave?: (value: string) => void
  /** Cursor-style ghost-text completion source. When provided (and enabled by the
      caller), Monaco shows the returned code as an inline suggestion; Tab accepts. */
  inlineComplete?: InlineCompleteFn
  /** Invoked when the user presses Cmd/Ctrl+K to request an inline AI edit. */
  onInlineEdit?: (selection: InlineEditSelection) => void
  /** Real compiler/language-server features supplied by the active workspace. */
  languageService?: MonacoLanguageService
}) {
  const editorSettings = useSettings().editor
  let host: HTMLDivElement | undefined
  let attributionCollection: ReturnType<monaco.editor.IStandaloneCodeEditor["createDecorationsCollection"]> | undefined
  let editor: monaco.editor.IStandaloneCodeEditor | undefined
  let applyingExternal = false
  let registeredUri: string | undefined
  let diagnosticsTimer: ReturnType<typeof setTimeout> | undefined

  // Route this editor's model to props.inlineComplete (read lazily so it stays current).
  const syncCompletion = () => {
    const uri = editor?.getModel()?.uri.toString()
    if (registeredUri && registeredUri !== uri) completionRegistry.delete(registeredUri)
    registeredUri = uri
    if (!uri) return
    if (props.inlineComplete) completionRegistry.set(uri, (input) => props.inlineComplete!(input))
    else completionRegistry.delete(uri)
    if (props.languageService) languageServiceRegistry.set(uri, props.languageService)
    else languageServiceRegistry.delete(uri)
  }

  const refreshDiagnostics = async () => {
    const model = editor?.getModel()
    if (!model) return
    const service = languageServiceRegistry.get(model.uri.toString())
    if (!service) {
      monaco.editor.setModelMarkers(model, "vector-lsp", [])
      return
    }
    const diagnostics = await service.diagnostics(model.uri.fsPath).catch(() => [])
    if (editor?.getModel() !== model) return
    monaco.editor.setModelMarkers(
      model,
      "vector-lsp",
      diagnostics.map((diagnostic) => ({
        ...monacoRange(diagnostic.range),
        severity:
          diagnostic.severity === 1
            ? monaco.MarkerSeverity.Error
            : diagnostic.severity === 2
              ? monaco.MarkerSeverity.Warning
              : diagnostic.severity === 3
                ? monaco.MarkerSeverity.Info
                : monaco.MarkerSeverity.Hint,
        code: diagnostic.code,
        source: diagnostic.source ?? "language server",
        message: diagnostic.message,
      })),
    )
  }

  const scheduleDiagnostics = (delay = 1_100) => {
    if (diagnosticsTimer) clearTimeout(diagnosticsTimer)
    diagnosticsTimer = setTimeout(() => void refreshDiagnostics(), delay)
  }

  onMount(() => {
    if (!host) return
    ensureMonacoEnvironment()
    ensureInlineProvider()
    ensureLanguageProviders()
    editor = monaco.editor.create(host, {
      model: modelFor(props.path, props.value),
      theme: "vector-dark",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", ui-monospace, monospace',
      fontLigatures: true,
      fontWeight: "450",
      minimap: { enabled: true, renderCharacters: false, maxColumn: 80, side: "right" },
      smoothScrolling: true,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      scrollBeyondLastLine: false,
      padding: { top: 14, bottom: 14 },
      bracketPairColorization: { enabled: true },
      stickyScroll: { enabled: true },
      renderLineHighlight: "all",
      renderLineHighlightOnlyWhenFocus: false,
      roundedSelection: true,
      guides: { indentation: true, bracketPairs: false },
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      tabSize: 2,
      inlineSuggest: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: "on",
      tabCompletion: "on",
      snippetSuggestions: "top",
      wordBasedSuggestions: "matchingDocuments",
      formatOnPaste: true,
      formatOnType: true,
      autoClosingBrackets: "always",
      autoClosingQuotes: "always",
      autoIndent: "full",
    })
    editor.onDidChangeModelContent(() => {
      if (applyingExternal) return
      props.onChange(editor!.getValue())
      scheduleDiagnostics()
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      props.onSave?.(editor!.getValue())
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      const selection = editor?.getSelection()
      const model = editor?.getModel()
      if (!selection || !model) return
      props.onInlineEdit?.({
        startOffset: model.getOffsetAt(selection.getStartPosition()),
        endOffset: model.getOffsetAt(selection.getEndPosition()),
        startLine: selection.startLineNumber,
        endLine: selection.endLineNumber,
        text: model.getValueInRange(selection),
      })
    })
    syncCompletion()
    scheduleDiagnostics(0)
    onCleanup(() => {
      if (registeredUri) completionRegistry.delete(registeredUri)
      if (registeredUri) languageServiceRegistry.delete(registeredUri)
      if (diagnosticsTimer) clearTimeout(diagnosticsTimer)
      editor?.dispose()
    })
  })

  // Keep the completion route pointed at the current model / callback.
  createEffect(() => {
    props.inlineComplete
    props.languageService
    syncCompletion()
    scheduleDiagnostics(0)
  })

  // Honor the app's editor settings live.
  createEffect(() => {
    editor?.updateOptions({
      wordWrap: editorSettings.wordWrap() ? "on" : "off",
      lineNumbers: editorSettings.showLineNumbers() ? "on" : "off",
      renderLineHighlight: editorSettings.highlightActiveLine() ? "all" : "none",
      renderWhitespace: editorSettings.renderWhitespace() ? "all" : "selection",
    })
  })

  createEffect(() => {
    const path = props.path
    const value = props.value
    if (!editor) return
    const current = editor.getModel()
    const nextUri = monaco.Uri.file(path || "untitled.txt")
    if (current?.uri.toString() !== nextUri.toString()) {
      applyingExternal = true
      editor.setModel(modelFor(path, value))
      applyingExternal = false
      syncCompletion()
      scheduleDiagnostics(0)
      return
    }
    // Paint one gutter stripe and line highlight per agent that recently edited
    // this file, so several agents working at once are visually distinguishable.
    const attributions = activeAttributions(props.attributions ?? [], Date.now())
    if (current) {
      attributionStyles(attributions)
      attributionCollection ??= editor.createDecorationsCollection()
      attributionCollection.set(
        attributions.flatMap((entry) =>
          entry.ranges
            .filter((range) => range.start >= 1 && range.end >= range.start)
            .map((range) => ({
              range: new monaco.Range(range.start, 1, Math.min(range.end, current.getLineCount()), 1),
              options: {
                isWholeLine: true,
                className: `vector-agent-line vector-agent-${cssId(entry.agentId)}`,
                linesDecorationsClassName: `vector-agent-gutter vector-agent-${cssId(entry.agentId)}`,
                hoverMessage: { value: `Edited by ${entry.agentName}` },
                overviewRuler: { color: entry.color, position: monaco.editor.OverviewRulerLane.Left },
              },
            })),
        ),
      )
    }

    // External updates (agent edits the open file) sync in without clobbering
    // the cursor during the user's own typing.
    if (current && current.getValue() !== value && !editor.hasTextFocus()) {
      applyingExternal = true
      // Replace the range rather than setValue: setValue discards decorations
      // and the undo stack, so per-agent attribution would vanish on the very
      // update that produced it.
      current.pushEditOperations(
        editor.getSelections(),
        [{ range: current.getFullModelRange(), text: value, forceMoveMarkers: true }],
        () => null,
      )
      applyingExternal = false
    }
  })

  return <div ref={host} class="vector-neon-editor relative h-full min-h-0 w-full overflow-hidden" />
}
