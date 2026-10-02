import { $ } from "bun"
import { Effect } from "effect"
import path from "node:path"
import { array, check, object, stable } from "./assertions"
import { http } from "./dsl"
import type { Scenario } from "./types"

export const workspaceScenarios: Scenario[] = [
  http.protected
    .post("/file/write", "workspace.file.write")
    .inProject({ git: false })
    .mutating()
    .seeded((ctx) =>
      Effect.sync(() => {
        check(ctx.directory !== undefined, "file write needs an isolated workspace")
        return {
          directory: ctx.directory,
          file: "nested/notes.txt",
          content: "Vector workspace write ✓\n",
        }
      }),
    )
    .at((ctx) => ({
      path: "/file/write",
      headers: ctx.headers(),
      body: { path: ctx.state.file, content: ctx.state.content },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.path === ctx.state.file, "file write should return the requested relative path")
        check(body.bytes === Buffer.byteLength(ctx.state.content, "utf8"), "file write should count UTF-8 bytes")
        const content = yield* Effect.promise(() => Bun.file(path.join(ctx.state.directory, ctx.state.file)).text())
        check(content === ctx.state.content, "file write should create parent directories and persist exact text")
      }),
    ),
  http.protected
    .post("/vcs/commit", "workspace.vcs.commit")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        check(ctx.directory !== undefined, "commit needs an isolated Git workspace")
        const before = (yield* git(ctx.directory, "rev-parse", "HEAD")).trim()
        yield* ctx.file("first.txt", "First committed file\n")
        yield* ctx.file("second.txt", "Second committed file\n")
        return { directory: ctx.directory, before, message: "Save workspace changes" }
      }),
    )
    .at((ctx) => ({ path: "/vcs/commit", headers: ctx.headers(), body: { message: ctx.state.message } }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(body.committed === true, "commit should stage and commit the changed workspace")
          check(typeof body.sha === "string" && /^[0-9a-f]{40}$/.test(body.sha), "commit should return its SHA")
          const head = (yield* git(ctx.state.directory, "rev-parse", "HEAD")).trim()
          check(head === body.sha && head !== ctx.state.before, "returned SHA should identify the new HEAD")
          const parent = (yield* git(ctx.state.directory, "rev-parse", "HEAD^")).trim()
          check(parent === ctx.state.before, "commit should preserve existing history")
          const message = (yield* git(ctx.state.directory, "log", "-1", "--format=%B")).trim()
          check(message === ctx.state.message, "commit should use the requested message")
          check(
            (yield* git(ctx.state.directory, "show", "HEAD:first.txt")) === "First committed file\n",
            "commit should include the first unstaged file",
          )
          check(
            (yield* git(ctx.state.directory, "show", "HEAD:second.txt")) === "Second committed file\n",
            "commit should include all unstaged files",
          )
          check(
            (yield* git(ctx.state.directory, "status", "--porcelain")).trim() === "",
            "commit should leave a clean tree",
          )
          const restore = (yield* git(ctx.state.directory, "tag", "--points-at", ctx.state.before)).trim()
          check(/^vector\/pre-commit-\d+$/.test(restore), "commit should retain a restore tag at the previous HEAD")
        }),
      "status",
    ),
  http.protected
    .get("/vcs/branches", "workspace.vcs.branches")
    .seeded((ctx) =>
      Effect.gen(function* () {
        check(ctx.directory !== undefined, "branch listing needs an isolated Git workspace")
        const current = (yield* git(ctx.directory, "symbolic-ref", "--short", "HEAD")).trim()
        const head = (yield* git(ctx.directory, "rev-parse", "HEAD")).trim()
        const other = `${current}-listed`
        yield* git(ctx.directory, "branch", other)
        return { directory: ctx.directory, current, head, other }
      }),
    )
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.current === ctx.state.current, "branch listing should identify the current branch")
        array(body.branches)
        check(body.branches.length === 2, "branch listing should include both local branches")
        const branches = body.branches.map((branch) => {
          object(branch)
          check(typeof branch.name === "string", "each branch should have a name")
          check(branch.checkedOutElsewhere === undefined, "neither branch is checked out in another worktree")
          return { name: branch.name, current: branch.current }
        })
        check(
          stable(branches.toSorted((left, right) => left.name.localeCompare(right.name))) ===
            stable(
              [
                { name: ctx.state.current, current: true },
                { name: ctx.state.other, current: false },
              ].toSorted((left, right) => left.name.localeCompare(right.name)),
            ),
          "branch listing should mark only the actual current branch",
        )
        check(
          (yield* git(ctx.state.directory, "rev-parse", "HEAD")).trim() === ctx.state.head &&
            (yield* git(ctx.state.directory, "symbolic-ref", "--short", "HEAD")).trim() === ctx.state.current,
          "listing branches should not move HEAD",
        )
      }),
    ),
  http.protected
    .post("/vcs/switch", "workspace.vcs.switch")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        check(ctx.directory !== undefined, "branch switching needs an isolated Git workspace")
        yield* git(ctx.directory, "config", "core.autocrlf", "false")
        const original = (yield* git(ctx.directory, "symbolic-ref", "--short", "HEAD")).trim()
        const before = (yield* git(ctx.directory, "rev-parse", "HEAD")).trim()
        const target = `${original}-switch`
        yield* git(ctx.directory, "switch", "-c", target)
        yield* ctx.file("branch-marker.txt", "Target branch contents\n")
        yield* git(ctx.directory, "add", "--", "branch-marker.txt")
        yield* git(ctx.directory, "commit", "-m", "Seed branch switch target")
        const targetHead = (yield* git(ctx.directory, "rev-parse", "HEAD")).trim()
        yield* git(ctx.directory, "switch", original)
        yield* ctx.file("untracked-note.txt", "Keep local work\n")
        return { directory: ctx.directory, original, before, target, targetHead }
      }),
    )
    .at((ctx) => ({ path: "/vcs/switch", headers: ctx.headers(), body: { branch: ctx.state.target } }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.branch === ctx.state.target, "switch should return the requested branch")
        check(
          (yield* git(ctx.state.directory, "symbolic-ref", "--short", "HEAD")).trim() === ctx.state.target,
          "switch should update the checkout's actual branch",
        )
        check(
          (yield* git(ctx.state.directory, "rev-parse", "HEAD")).trim() === ctx.state.targetHead,
          "switch should check out the target commit",
        )
        check(
          (yield* git(ctx.state.directory, "rev-parse", `refs/heads/${ctx.state.original}`)).trim() ===
            ctx.state.before,
          "switch should preserve the original branch history",
        )
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.state.directory, "branch-marker.txt")).text())) ===
            "Target branch contents\n",
          "switch should materialize the target branch's tracked file",
        )
        check(
          (yield* Effect.promise(() => Bun.file(path.join(ctx.state.directory, "untracked-note.txt")).text())) ===
            "Keep local work\n",
          "switch should preserve unrelated untracked work",
        )
      }),
    ),
  // Disabled LSP is a supported editor mode: valid requests return no results and never rewrite source files.
  ...[
    { route: "diagnostics", input: {}, expected: [] },
    { route: "hover", input: { line: 0, character: 13 }, expected: null },
    { route: "definition", input: { line: 1, character: 12 }, expected: [] },
    { route: "references", input: { line: 0, character: 13 }, expected: [] },
    { route: "symbols", input: {}, expected: [] },
    { route: "rename", input: { line: 0, character: 13, newName: "renamed" }, expected: { files: [] } },
    {
      route: "code-action",
      input: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 23 } } },
      expected: { actions: [] },
    },
  ].map((entry) =>
    http.protected
      .post(`/lsp/${entry.route}`, `workspace.lsp.${entry.route}.disabled`)
      .inProject({ git: false, config: { lsp: false } })
      .seeded((ctx) =>
        Effect.gen(function* () {
          check(ctx.directory !== undefined, "LSP requests need an isolated workspace")
          const file = "src/main.ts"
          const content = "export const value = 42\nconsole.log(value)\n"
          yield* ctx.file(file, content)
          return { file, content, absolute: path.join(ctx.directory, file) }
        }),
      )
      .at((ctx) => ({
        path: `/lsp/${entry.route}`,
        headers: ctx.headers(),
        body: { file: ctx.state.file, ...entry.input },
      }))
      .jsonEffect(200, (body, ctx) =>
        Effect.gen(function* () {
          check(stable(body) === stable(entry.expected), `disabled LSP ${entry.route} should return no results`)
          const content = yield* Effect.promise(() => Bun.file(ctx.state.absolute).text())
          check(content === ctx.state.content, `LSP ${entry.route} should leave source text unchanged`)
        }),
      ),
  ),
]

function git(directory: string, ...args: string[]) {
  return Effect.promise(() => $`git -C ${directory} ${args}`.quiet().text())
}
