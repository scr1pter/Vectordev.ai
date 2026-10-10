import { constants } from "node:fs"
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { capture } from "./capture"
import type { EvalTask } from "./tasks"

export type ValidationResult = {
  checkExitCode: number
  output: string
  protectedViolations: string[]
  assertionFailures: string[]
  mutationsCaught: number
  wallMs: number
  error?: string
}

// Never execute a check in an agent-owned tree: package/preload configuration
// and evaluator tests there may have changed along with the implementation.
export async function validateTask(input: {
  task: EvalTask
  agentDir: string
  root: string
  timeoutMs: number
}): Promise<ValidationResult> {
  const started = performance.now()
  const violations = new Set<string>()
  const grading = await mkdtemp(join(input.root, "grading-")).catch((error: unknown) => ({
    error: error instanceof Error ? error.message : String(error),
  }))
  if (typeof grading !== "string")
    return {
      checkExitCode: 127,
      output: "",
      protectedViolations: [],
      assertionFailures: [],
      mutationsCaught: 0,
      wallMs: Math.round(performance.now() - started),
      error: grading.error,
    }
  const result = await grade(input, grading, violations).catch((error: unknown) => ({
    checkExitCode: 127,
    output: "",
    protectedViolations: [...violations].sort(),
    assertionFailures: [],
    mutationsCaught: 0,
    error: error instanceof Error ? error.message : String(error),
  }))
  const cleanupError = await rm(grading, { recursive: true, force: true }).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )
  return {
    ...result,
    ...(cleanupError ? { error: cleanupError } : {}),
    wallMs: Math.round(performance.now() - started),
  }
}

async function grade(
  input: { task: EvalTask; agentDir: string; timeoutMs: number },
  grading: string,
  violations: Set<string>,
) {
  const protectedFiles = new Set([
    ...input.task.protectedFiles,
    ...Object.keys(input.task.files).filter((path) => infrastructure(path) || testFile(path)),
  ])
  for (const [path, content] of Object.entries(input.task.files)) {
    if (!fixturePath(path)) throw new Error(`Invalid evaluator fixture path: ${path}`)
    if (!protectedFiles.has(path)) continue
    await mkdir(dirname(join(grading, path)), { recursive: true })
    await writeFile(join(grading, path), content)
  }

  const files = await agentFiles(input.agentDir, violations)
  const contents = new Map<string, Buffer>()
  for (const path of files) {
    if (!fixturePath(path)) {
      violations.add(`${path} (invalid relative path)`)
      continue
    }
    const content = await readAgentFile(join(input.agentDir, path)).catch(() => undefined)
    if (!content) {
      violations.add(`${path} (unreadable or changed during validation)`)
      continue
    }
    contents.set(path, content)
    if (protectedFiles.has(path)) continue
    if (
      [...protectedFiles].some(
        (protectedPath) => protectedPath.startsWith(`${path}/`) || path.startsWith(`${protectedPath}/`),
      )
    ) {
      violations.add(path)
      continue
    }
    if (infrastructure(path)) {
      violations.add(path)
      continue
    }
    if (testFile(path) && (input.task.category !== "test-writing" || !path.startsWith("test/"))) {
      violations.add(path)
      continue
    }
    await mkdir(dirname(join(grading, path)), { recursive: true })
    await writeFile(join(grading, path), content)
  }
  for (const path of protectedFiles)
    if (contents.get(path)?.toString("utf8") !== input.task.files[path]) violations.add(path)

  const assertionFailures = (
    await Promise.all(
      input.task.assertions.map(async (assertion) => {
        const content = await readFile(join(grading, assertion.path), "utf8").catch(() => undefined)
        if (content === undefined) return assertion.exists === false ? undefined : `${assertion.path} is missing`
        if (assertion.exists === false) return `${assertion.path} should not exist`
        const missing = (assertion.includes ?? []).filter((needle) => !content.includes(needle))
        const lingering = (assertion.excludes ?? []).filter((needle) => content.includes(needle))
        return (
          [
            ...(missing.length > 0 ? [`${assertion.path} does not contain ${missing.join(", ")}`] : []),
            ...(lingering.length > 0 ? [`${assertion.path} still contains ${lingering.join(", ")}`] : []),
          ].join("; ") || undefined
        )
      }),
    )
  ).filter((entry): entry is string => entry !== undefined)

  const check = await capture({ ...input.task.check, cwd: grading, timeoutMs: input.timeoutMs })
  const bunTests = basename(input.task.check.command) === "bun" && input.task.check.args[0] === "test"
  const completed =
    !bunTests ||
    (/^\s*[1-9]\d* pass\s*$/m.test(check.output) &&
      /^\s*0 fail\s*$/m.test(check.output) &&
      /^Ran [1-9]\d* tests? across /m.test(check.output))
  const checkExitCode = check.exitCode === 0 && !completed ? 1 : check.exitCode
  const mutationNotes: string[] = []
  const caught: string[] = []
  if (checkExitCode === 0 && !check.timedOut && violations.size === 0 && assertionFailures.length === 0)
    for (const mutation of input.task.mutations) {
      if (!fixturePath(mutation.path)) throw new Error(`Invalid evaluator mutation path: ${mutation.path}`)
      const path = join(grading, mutation.path)
      const original = await readFile(path, "utf8").catch(() => undefined)
      if (original === undefined || !original.includes(mutation.find)) {
        mutationNotes.push(`${mutation.id}: not applied; seeded target is absent`)
        continue
      }
      await writeFile(path, original.replace(mutation.find, mutation.replace))
      const result = await capture({ ...input.task.check, cwd: grading, timeoutMs: input.timeoutMs })
      await writeFile(path, original)
      // A process error, test import error, or timeout does not establish that
      // an assertion detected the defect. Bun emits a named (fail) record only
      // after an actual registered test fails.
      const detected =
        bunTests &&
        result.exitCode === 1 &&
        !result.timedOut &&
        /^\(fail\)\s+\S/m.test(result.output) &&
        /^\s*[1-9]\d* fail\s*$/m.test(result.output) &&
        !/^\s*[1-9]\d* errors?\s*$/m.test(result.output)
      if (detected) caught.push(mutation.id)
      mutationNotes.push(
        `${mutation.id}: ${detected ? "caught by failing test" : result.timedOut ? "not caught; check timed out" : `not caught; check exited ${result.exitCode} without a qualifying test failure`}`,
      )
    }
  return {
    checkExitCode,
    output: [
      check.output,
      ...(check.exitCode === 0 && !completed ? ["Check exited 0 without a completed passing test suite"] : []),
      ...mutationNotes,
    ].join("\n"),
    protectedViolations: [...violations].sort(),
    assertionFailures,
    mutationsCaught: caught.length,
  }
}

function fixturePath(path: string) {
  return (
    !isAbsolute(path) &&
    !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  )
}

function infrastructure(path: string) {
  const name = basename(path)
  return (
    [
      "package.json",
      ".gitignore",
      "bunfig.toml",
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      ".npmrc",
      ".yarnrc",
      ".yarnrc.yml",
    ].includes(name) ||
    /^tsconfig(?:\.[^.]+)*\.json$/.test(name) ||
    /^\.env(?:\..*)?$/.test(name) ||
    /\.config\.[cm]?[jt]s$/.test(name)
  )
}

function testFile(path: string) {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
}

async function agentFiles(root: string, violations: Set<string>, prefix = ""): Promise<string[]> {
  const result: string[] = []
  if (!prefix && !(await lstat(root)).isDirectory()) {
    violations.add("agent directory (not a regular directory)")
    return result
  }
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if ([".git", ".vector", ".codex", ".claude", ".cursor"].includes(entry.name)) continue
    if (["node_modules", ".bun"].includes(entry.name)) {
      violations.add(path)
      continue
    }
    if (entry.isSymbolicLink()) {
      violations.add(`${path} (symlink)`)
      continue
    }
    if (entry.isDirectory()) {
      // lstat avoids traversing an already replaced directory symlink.
      if (!(await lstat(join(root, path))).isDirectory()) {
        violations.add(`${path} (changed during validation)`)
        continue
      }
      result.push(...(await agentFiles(root, violations, path)))
      continue
    }
    if (entry.isFile()) {
      result.push(path)
      continue
    }
    violations.add(`${path} (unsupported file type)`)
  }
  return result.sort()
}

async function readAgentFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (!(await file.stat()).isFile()) throw new Error("Not a regular file")
    return await file.readFile()
  } finally {
    await file.close()
  }
}
