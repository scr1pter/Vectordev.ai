// The desktop app runs the Node bundle in Electron's utility process, where `Bun` is undefined, so any Bun-only API the
// bundle reaches throws a ReferenceError at runtime. This finds those references in the bundled JavaScript.

// References kept in the Node bundle on purpose, keyed by the `// <path>` comment Bun.build prints before each module.
// Each one must be unreachable on Node.js.
export const allowed = [
  // LocalPluginSdk.prepare returns before it resolves anything when typeof Bun is "undefined", and the compat runtime
  // that calls the resolver from a rewritten plugin is only registered under Bun.
  { module: "../core/src/plugin/local-sdk.ts", api: "Bun.resolveSync" },
  // installRuntime is only called by LocalPluginSdk.prepare, after the same guard.
  { module: "../core/src/plugin/local-sdk.ts", api: "Bun.plugin" },
]

// Strings, comments, template text and regular expressions are skipped. A bare `typeof Bun` is always safe, and a
// reference after a `typeof Bun` check on the same line, as in `typeof Bun === "undefined" ? undefined : Bun.$`, counts
// as guarded. Throws when it loses track of the syntax, so a bundle it cannot read never passes.
export function unguardedBunReferences(code: string, allow: { module: string; api: string }[] = allowed) {
  const found: { index: number; module: string; api: string }[] = []
  // The brace depth at each open `${` substitution, so its closing brace resumes the template text.
  const substitutions: number[] = []
  const word = /[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/y
  const number = /[\w.]*/y
  let depth = 0
  let index = code.startsWith("#!") ? code.indexOf("\n") + 1 || code.length : 0
  let module = ""
  let guard = -1
  let previous = ""
  let prior = ""
  const push = (token: string) => {
    prior = previous
    previous = token
  }
  const fail = (at: number, reason: string): never => {
    throw new Error(`Node bundle scan lost track of the syntax at line ${lineOf(code, at)}: ${reason}`)
  }
  const template = (start: number) => {
    for (let at = start; at < code.length; at++) {
      if (code[at] === "\\") at++
      else if (code[at] === "`") return at + 1
      else if (code[at] === "$" && code[at + 1] === "{") {
        substitutions.push(depth)
        return at + 2
      }
    }
    return fail(start, "unterminated template literal")
  }

  while (index < code.length) {
    const char = code[index]
    const next = code[index + 1]
    if (char === " " || char === "\n" || char === "\t" || char === "\r" || (char > "~" && /\s/.test(char))) {
      index++
      continue
    }
    if (char === "/" && next === "/") {
      const end = code.indexOf("\n", index) === -1 ? code.length : code.indexOf("\n", index)
      // Bun.build marks the start of each module's code with `// <path>` at column 0.
      const marker = /^\/\/ (\S+)$/.exec(code.slice(index, end))
      if (marker && (index === 0 || code[index - 1] === "\n")) module = marker[1]
      index = end
      continue
    }
    if (char === "/" && next === "*") {
      const end = code.indexOf("*/", index + 2)
      if (end === -1) fail(index, "unterminated comment")
      index = end + 2
      continue
    }
    if (char === '"' || char === "'") {
      const start = index
      for (index++; code[index] !== char; index++) {
        if (index >= code.length || code[index] === "\n") fail(start, "unterminated string")
        if (code[index] === "\\") index++
      }
      index++
      const value = code.slice(start + 1, index - 1)
      const imported =
        previous === "from" || previous === "import" || (previous === "(" && /^(import|\w*require)$/.test(prior))
      if (imported && /^bun(:|$)/.test(value)) found.push({ index: start, module, api: `import "${value}"` })
      push('""')
      continue
    }
    if (char === "`") {
      index = template(index + 1)
      push("``")
      continue
    }
    if (char === "}" && substitutions.at(-1) === depth) {
      substitutions.pop()
      index = template(index + 1)
      push("``")
      continue
    }
    if (char === "/") {
      const end = regexEnd(code, index, previous)
      push(end === index ? "/" : "/re/")
      index = end === index ? index + 1 : end
      continue
    }
    if ((char >= "0" && char <= "9") || (char === "." && next >= "0" && next <= "9")) {
      number.lastIndex = index
      number.exec(code)
      index = number.lastIndex
      push("0")
      continue
    }
    word.lastIndex = index
    const name = word.exec(code)?.[0]
    if (name === "Bun" || name === "import") {
      const property = previous === "." || previous === "?." || previous === "#"
      const after = code.slice(index + name.length, index + name.length + 64)
      const guarded = guard !== -1 && code.lastIndexOf("\n", index) < guard
      // `typeof Bun.x` and `typeof Bun?.x` still read the global, so only a bare `typeof Bun` is a check.
      const bare = !/^\s*(\?\.|[.[(])/.test(after)
      // An object key such as `{ Bun: value }` names a property rather than reading the global.
      const key = (previous === "{" || previous === ",") && /^\s*:/.test(after)
      if (name === "Bun" && !property && previous === "typeof" && bare) guard = index
      if (name === "Bun" && !property && !(previous === "typeof" && bare) && !key && !guarded) {
        const member = /^\s*\.\s*([\w$]+)/.exec(after)?.[1]
        found.push({ index, module, api: member ? `Bun.${member}` : "Bun" })
      }
      const meta = name === "import" && !property && /^\.meta\.(dir|file|path|main|require)\b/.exec(after)?.[1]
      if (meta && !guarded) found.push({ index, module, api: `import.meta.${meta}` })
    }
    if (name) {
      push(name)
      index += name.length
      continue
    }
    if (char === "{") depth++
    if (char === "}") depth--
    if (char === "?" && next === "." && !(code[index + 2] >= "0" && code[index + 2] <= "9")) {
      push("?.")
      index += 2
      continue
    }
    // A postfix ++ or -- ends a value, so a slash after it divides.
    if ((char === "+" || char === "-") && next === char) {
      push(regexAllowed(previous) ? char + char : "0")
      index += 2
      continue
    }
    push(char)
    index++
  }
  if (depth !== 0 || substitutions.length) fail(code.length, "unbalanced braces")

  return found
    .filter((item) => !allow.some((entry) => entry.module === item.module && entry.api === item.api))
    .map((item) => ({ line: lineOf(code, item.index), module: item.module, api: item.api }))
}

// Returns the index after the regular expression literal starting at `index`, or `index` when the slash divides.
function regexEnd(code: string, index: number, previous: string) {
  if (!regexAllowed(previous)) return index
  const flags = /[\w$]*/y
  let inClass = false
  for (let at = index + 1; at < code.length; at++) {
    const char = code[at]
    if (char === "\n") return index
    if (char === "\\") at++
    else if (char === "[") inClass = true
    else if (char === "]") inClass = false
    else if (char === "/" && !inClass) {
      flags.lastIndex = at + 1
      flags.exec(code)
      return flags.lastIndex
    }
  }
  return index
}

// A slash starts a regular expression unless the previous token ends a value. In bundled code `}` almost always closes
// a block, after which a slash starts an expression.
function regexAllowed(previous: string) {
  if (expressionKeywords.has(previous)) return true
  if (/^[\w$\u0080-￿]/.test(previous)) return false
  return ![")", "]", '""', "``", "/re/"].includes(previous)
}

const expressionKeywords = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "default",
  "extends",
])

function lineOf(code: string, index: number) {
  let line = 1
  for (let at = code.indexOf("\n"); at !== -1 && at < index; at = code.indexOf("\n", at + 1)) line++
  return line
}
