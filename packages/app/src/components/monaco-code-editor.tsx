import { createEffect, onCleanup, onMount } from "solid-js"
import * as monaco from "monaco-editor"
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
  monaco.editor.defineTheme("vector-dark", {
    base: "vs-dark",
    inherit: true,
    // Cursor / VS Code dark defaults — blue property keys, orange strings,
    // green numbers, teal types, yellow functions; neutral punctuation.
    rules: [
      { token: "comment", foreground: "6a9955", fontStyle: "italic" },
      { token: "keyword", foreground: "569cd6" },
      { token: "string", foreground: "ce9178" },
      { token: "number", foreground: "b5cea8" },
      { token: "regexp", foreground: "d16969" },
      { token: "type", foreground: "4ec9b0" },
      { token: "class", foreground: "4ec9b0" },
      { token: "function", foreground: "dcdcaa" },
      { token: "variable", foreground: "9cdcfe" },
      { token: "constant", foreground: "569cd6" },
      { token: "operator", foreground: "d4d4d4" },
      { token: "delimiter", foreground: "d4d4d4" },
      { token: "tag", foreground: "569cd6" },
      { token: "attribute.name", foreground: "9cdcfe" },
      { token: "attribute.value", foreground: "ce9178" },
      { token: "string.key.json", foreground: "9cdcfe" },
      { token: "string.value.json", foreground: "ce9178" },
      { token: "keyword.json", foreground: "569cd6" },
      { token: "number.json", foreground: "b5cea8" },
    ],
    colors: {
      "editor.background": "#1b1b1b",
      "editor.foreground": "#d4d4d4",
      "editorGutter.background": "#1b1b1b",
      "editorLineNumber.foreground": "#6e6e78",
      "editorLineNumber.activeForeground": "#c6c6c6",
      "editor.lineHighlightBackground": "#26262b",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#264f78",
      "editor.inactiveSelectionBackground": "#3a3d41",
      "editor.selectionHighlightBackground": "#2d3a4a",
      "editorCursor.foreground": "#d4d4d4",
      "editorIndentGuide.background1": "#3a3a40",
      "editorIndentGuide.activeBackground1": "#6a6a72",
      "editorWhitespace.foreground": "#3a3a40",
      "editorWidget.background": "#252528",
      "editorWidget.border": "#303036",
      "editorHoverWidget.background": "#252528",
      "editorHoverWidget.border": "#303036",
      "editorSuggestWidget.background": "#252528",
      "editorSuggestWidget.border": "#303036",
      "editorSuggestWidget.selectedBackground": "#2a2d2e",
      "editorGhostText.foreground": "#6a6a72",
      "editorBracketMatch.background": "#00000000",
      "editorBracketMatch.border": "#3d3d45",
      "minimap.background": "#1b1b1b",
      "editorStickyScroll.background": "#1b1b1b",
      "editorStickyScrollHover.background": "#26262b",
      "editorOverviewRuler.border": "#00000000",
      "scrollbarSlider.background": "#56565e66",
      "scrollbarSlider.hoverBackground": "#64646e99",
      "scrollbarSlider.activeBackground": "#6e6e78bb",
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

export function MonacoCodeEditor(props: {
  path: string
  value: string
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
    // External updates (agent edits the open file) sync in without clobbering
    // the cursor during the user's own typing.
    if (current && current.getValue() !== value && !editor.hasTextFocus()) {
      applyingExternal = true
      current.setValue(value)
      applyingExternal = false
    }
  })

  return <div ref={host} class="h-full min-h-0 w-full overflow-hidden" />
}
