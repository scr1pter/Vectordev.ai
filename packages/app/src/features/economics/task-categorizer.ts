import type { TaskCategory } from "./economics-types"

// Deterministic keyword classifier for routing a task prompt to a
// TaskCategory. PRECEDENCE MATTERS: a prompt is scored against these rules in
// exact order and the first keyword match wins — this list is not
// alphabetical or otherwise reorderable without changing behavior. Earlier
// rules are checked first because they're the more specific signal (e.g. a
// prompt mentioning both "fix" and "button" should read as a bug-fix, not a
// frontend task — bug-fix precedes frontend below).
const CATEGORY_RULES: { category: TaskCategory; keywords: string[] }[] = [
  { category: "documentation", keywords: ["documentation", "readme", "changelog", "jsdoc", "doc", "docs"] },
  { category: "bug-fix", keywords: ["fix", "bug", "error", "broken", "crash", "exception", "regression"] },
  { category: "small-edit", keywords: ["typo", "rename", "small", "tiny", "minor", "tweak"] },
  {
    category: "frontend",
    keywords: ["ui", "css", "component", "page", "frontend", "front-end", "style", "styling", "layout", "button", "tailwind"],
  },
  {
    category: "backend",
    keywords: ["api", "server", "backend", "back-end", "database", "db", "endpoint", "route", "migration"],
  },
  { category: "refactor", keywords: ["refactor", "restructure", "cleanup", "clean up", "reorganize"] },
  { category: "architecture", keywords: ["architecture", "design", "schema", "system design", "structure"] },
  { category: "testing", keywords: ["test", "tests", "spec", "coverage", "testing", "unit test", "e2e"] },
]

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function matchesKeyword(prompt: string, keyword: string) {
  return new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i").test(prompt)
}

export function categorizeTask(prompt: string): TaskCategory {
  const text = prompt.trim()
  if (!text) return "general"

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => matchesKeyword(text, keyword))) return rule.category
  }

  return "general"
}
