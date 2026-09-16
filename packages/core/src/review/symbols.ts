// Declarations in a diff's added lines, so Vector can grep for their callers and give the reviewer cross-file
// context that weak models would not find on their own. Regex-based on purpose: good enough for TS/JS, Python, Go,
// Rust and Java declarations, and browser-safe.

import type { DiffFile } from "./diff"

export interface ChangedSymbol {
  name: string
  path: string
  line: number
  kind: "function" | "class" | "type" | "method" | "variable"
}

type Language = "ts" | "py" | "go" | "rs" | "java"
type Match = { name: string; kind: ChangedSymbol["kind"]; exported: boolean }

const LANGUAGES: Record<string, Language> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  py: "py",
  pyi: "py",
  go: "go",
  rs: "rs",
  java: "java",
}

const KEYWORDS = new Set(
  "if for while switch catch function return constructor else do with new throw try synchronized super this typeof await yield".split(
    " ",
  ),
)

// Names so common that grepping for them returns noise.
const COMMON = new Set(
  "main init render tostring equals hashcode run get set default test setup teardown handler index app props state config options data result value self args ctx __init__ __str__ __repr__ new".split(
    " ",
  ),
)

const ID = "[A-Za-z_$][\\w$]*"
const ARROW = new RegExp(`=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>)`)

function match(language: Language, text: string): Match | undefined {
  const indented = /^\s/.test(text)
  let found: RegExpExecArray | null
  if (language === "ts") {
    const exported = /^\s*export\b/.test(text)
    if (
      (found = new RegExp(
        `^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})`,
      ).exec(text))
    )
      return { name: found[1], kind: "function", exported }
    if (
      (found = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})`).exec(
        text,
      ))
    )
      return { name: found[1], kind: "class", exported }
    if (
      (found = new RegExp(
        `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?(?:interface|type|enum|namespace)\\s+(${ID})`,
      ).exec(text))
    )
      return { name: found[1], kind: "type", exported }
    if (
      (found = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]*)?=`).exec(
        text,
      ))
    )
      return { name: found[1], kind: ARROW.test(text) ? "function" : "variable", exported }
    const method = new RegExp(
      `^\\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)*\\*?(${ID})\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^={]+)?\\{\\s*$`,
    ).exec(text)
    if (method) return { name: method[1], kind: "method", exported: false }
    return undefined
  }
  if (language === "py") {
    if ((found = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(text)))
      return {
        name: found[1],
        kind: indented ? "method" : "function",
        exported: !indented && !found[1].startsWith("_"),
      }
    if ((found = /^\s*class\s+([A-Za-z_]\w*)/.exec(text)))
      return { name: found[1], kind: "class", exported: !indented && !found[1].startsWith("_") }
    if ((found = /^([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=(?!=)/.exec(text)))
      return { name: found[1], kind: "variable", exported: true }
    return undefined
  }
  if (language === "go") {
    const exported = (name: string) => /^[A-Z]/.test(name)
    if ((found = /^func\s+\([^)]*\)\s*([A-Za-z_]\w*)\s*[[(]/.exec(text)))
      return { name: found[1], kind: "method", exported: exported(found[1]) }
    if ((found = /^func\s+([A-Za-z_]\w*)\s*[[(]/.exec(text)))
      return { name: found[1], kind: "function", exported: exported(found[1]) }
    if ((found = /^\s*type\s+([A-Za-z_]\w*)\s+\S/.exec(text)))
      return { name: found[1], kind: "type", exported: exported(found[1]) }
    if ((found = /^(?:var|const)\s+([A-Za-z_]\w*)\b/.exec(text)))
      return { name: found[1], kind: "variable", exported: exported(found[1]) }
    return undefined
  }
  if (language === "rs") {
    const exported = /^\s*pub\b/.test(text)
    const vis = "(?:pub(?:\\([^)]*\\))?\\s+)?"
    if (
      (found = new RegExp(
        `^\\s*${vis}(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+([A-Za-z_]\\w*)`,
      ).exec(text))
    )
      return { name: found[1], kind: indented ? "method" : "function", exported }
    if ((found = new RegExp(`^\\s*${vis}(?:struct|enum|trait|union|type)\\s+([A-Za-z_]\\w*)`).exec(text)))
      return { name: found[1], kind: "type", exported }
    if ((found = new RegExp(`^\\s*${vis}(?:const|static)\\s+(?:mut\\s+)?([A-Za-z_]\\w*)\\s*:`).exec(text)))
      return { name: found[1], kind: "variable", exported }
    if ((found = /^\s*macro_rules!\s*([A-Za-z_]\w*)/.exec(text))) return { name: found[1], kind: "function", exported }
    return undefined
  }
  const exported = /^\s*(?:[\w-]+\s+)*public\b/.test(text)
  if (
    (found =
      /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/.exec(
        text,
      ))
  )
    return { name: found[1], kind: "class", exported }
  if (
    (found =
      /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)+(?:<[^>]+>\s+)?[\w$<>[\],.?]+\s+([a-z_$][\w$]*)\s*\(/.exec(
        text,
      ))
  )
    return { name: found[1], kind: "method", exported }
  if ((found = /^\s+[\w$<>[\],.?]+\s+([a-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws\s+[\w$.,\s]+)?\{\s*$/.exec(text)))
    return { name: found[1], kind: "method", exported: false }
  return undefined
}

const KIND_ORDER: Record<ChangedSymbol["kind"], number> = { function: 0, class: 0, type: 0, method: 1, variable: 2 }

// Up to `limit` distinct names declared in added lines: exported ones first, then functions, classes and types, then
// methods, then variables. Names in removed lines are ignored.
export function changedSymbols(files: DiffFile[], limit = 10): ChangedSymbol[] {
  const found: (ChangedSymbol & { exported: boolean; order: number })[] = []
  for (const file of files) {
    const language = LANGUAGES[file.path.slice(file.path.lastIndexOf(".") + 1).toLowerCase()]
    if (!language || file.binary) continue
    for (const hunk of file.hunks)
      for (const line of hunk.lines) {
        if (line.kind !== "add") continue
        const item = match(language, line.text)
        if (!item || item.name.length < 3 || KEYWORDS.has(item.name) || COMMON.has(item.name.toLowerCase())) continue
        found.push({
          name: item.name,
          path: file.path,
          line: line.newLine!,
          kind: item.kind,
          exported: item.exported,
          order: found.length,
        })
      }
  }
  const seen = new Set<string>()
  return found
    .toSorted(
      (a, b) => Number(b.exported) - Number(a.exported) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.order - b.order,
    )
    .filter((item) => !seen.has(item.name) && !!seen.add(item.name))
    .slice(0, limit)
    .map(({ name, path, line, kind }) => ({ name, path, line, kind }))
}
