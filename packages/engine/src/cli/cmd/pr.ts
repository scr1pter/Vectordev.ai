import { Effect, Schema } from "effect"
import { PublicSession } from "@vectordevai/schema/public-session"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { Location } from "@vectordevai/core/location"
import { AbsolutePath } from "@vectordevai/core/schema"
import { select, isCancel } from "@clack/prompts"
import { UI } from "../ui"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"
import { Process } from "@/util/process"

// Relaunch Vector after checking out the pull request.
const selfBin = "vector"

export const PrCommand = effectCmd({
  command: "pr <number>",
  describe: "fetch and checkout a GitHub PR branch, then run Vector",
  builder: (yargs) =>
    yargs
      .positional("number", {
        type: "number",
        describe: "PR number to checkout",
        demandOption: true,
      })
      .option("import-session", {
        type: "boolean",
        default: true,
        describe: "import a linked public Vector session as passive history",
      })
      .option("session-url", {
        type: "string",
        describe: "select a public Vector session URL when the PR links several",
      }),
  handler: Effect.fn("Cli.pr")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail("Could not load instance context")
    if (ctx.project.vcs !== "git") {
      return yield* fail("Could not find git repository. Please run this command from a git repository.")
    }

    if (!args["import-session"] && args["session-url"])
      return yield* fail("--session-url cannot be used with --no-import-session")

    const imported: { sessionID?: string } = {}
    const git = yield* Git.Service
    const worktree = ctx.worktree

    const prNumber = args.number
    const localBranchName = `pr/${prNumber}`
    UI.println(`Fetching and checking out PR #${prNumber}...`)

    const checkout = yield* Effect.promise(() =>
      Process.run(["gh", "pr", "checkout", `${prNumber}`, "--branch", localBranchName, "--force"], { nothrow: true }),
    )
    if (checkout.code !== 0) {
      return yield* fail(`Failed to checkout PR #${prNumber}. Make sure you have gh CLI installed and authenticated.`)
    }

    const prInfoResult = yield* Effect.promise(() =>
      Process.text(
        [
          "gh",
          "pr",
          "view",
          `${prNumber}`,
          "--json",
          "headRepository,headRepositoryOwner,isCrossRepository,headRefName,body",
        ],
        { nothrow: true },
      ),
    )

    if (prInfoResult.code === 0 && prInfoResult.text.trim()) {
      const prInfo = JSON.parse(prInfoResult.text)
      if (args["import-session"]) {
        const links = publicSessionLinks(typeof prInfo?.body === "string" ? prInfo.body : "")
        if (!args["session-url"] && links.length > 1 && !process.stdin.isTTY)
          return yield* fail(
            "This PR links several public sessions. Select one with --session-url <url>, or use --no-import-session.",
          )
        const selected =
          args["session-url"] ??
          (links.length > 1
            ? yield* Effect.promise(() =>
                select({
                  message: "Select the public session to import as passive history",
                  options: links.map((url) => ({ value: url, label: url })),
                }),
              )
            : links[0])
        if (isCancel(selected)) return
        if (selected) {
          const shares = yield* PublicSessionShare.Service
          const archive = yield* shares
            .read(selected)
            .pipe(Effect.mapError((error) => new CliError({ message: error.message })))
          const restored = yield* shares
            .import({
              archive,
              targetEngine: "v1",
              location: Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }),
            })
            .pipe(Effect.mapError((error) => new CliError({ message: error.message })))
          imported.sessionID = restored.sessionID
          UI.println(
            `Imported portable ${archive.engine} transcript into ${restored.engine} as passive CLI history: ${restored.sessionID}`,
          )
        }
      }

      if (prInfo?.isCrossRepository && prInfo.headRepository && prInfo.headRepositoryOwner) {
        const forkOwner = prInfo.headRepositoryOwner.login
        const forkName = prInfo.headRepository.name
        const remoteName = forkOwner

        const remotes = (yield* git.run(["remote"], { cwd: worktree })).text().trim()
        if (!remotes.split("\n").includes(remoteName)) {
          yield* git.run(["remote", "add", remoteName, `https://github.com/${forkOwner}/${forkName}.git`], {
            cwd: worktree,
          })
          UI.println(`Added fork remote: ${remoteName}`)
        }

        yield* git.run(["branch", `--set-upstream-to=${remoteName}/${prInfo.headRefName}`, localBranchName], {
          cwd: worktree,
        })
      }
    }

    UI.println(`Successfully checked out PR #${prNumber} as branch '${localBranchName}'`)
    UI.println()
    UI.println("Starting Vector...")
    UI.println()

    const code = yield* Effect.promise(
      () =>
        Process.spawn([selfBin, ...(imported.sessionID ? ["--session", imported.sessionID] : [])], {
          inheritInternalEnv: true,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          cwd: process.cwd(),
        }).exited,
    )
    // Match legacy throw semantics — propagate as a defect so the top-level
    // index.ts catch handles it identically (exit 1, "Unexpected error" banner).
    if (code !== 0) return yield* Effect.die(new Error(`vector exited with code ${code}`))
  }),
})

/** Extract complete owned URLs; never turn a lookalike URL into a trusted prefix. */
export function publicSessionLinks(body: string): string[] {
  return [
    ...new Set(
      (body.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [])
        .map((url) => url.replace(/[),.;\]}]+$/, ""))
        .filter(Schema.is(PublicSession.Info.fields.url)),
    ),
  ]
}
