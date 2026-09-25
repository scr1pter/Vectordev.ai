import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { githubShareConsent, prepareGithubEnvironment } from "./github.environment"
import type { PublicSession } from "@vectordevai/schema/public-session"
import { TASK_MENTIONS, mentionsFrom, routeGithubEvent } from "./github.route"

export { extractResponseText, formatPromptTooLargeError, parseGitHubRemote } from "./github.shared"

export const GithubInstallCommand = effectCmd({
  command: "install",
  describe: "install the GitHub agent",
  handler: () =>
    Effect.gen(function* () {
      const { githubInstall } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubInstall()
    }),
})

// Capture workflow consent before project configuration and plugins are loaded.
const sharing = new WeakMap<object, PublicSession.Consent | undefined>()

export const GithubRunCommand = effectCmd({
  command: "run",
  describe: "run the GitHub agent",
  builder: (yargs) =>
    yargs
      .option("event", {
        type: "string",
        describe: "GitHub mock event to run the agent for",
      })
      .option("token", {
        type: "string",
        describe: "GitHub personal access token (github_pat_********)",
      }),
  instance: (args) => {
    sharing.set(args, githubShareConsent(process.env))
    const warning = prepareGithubEnvironment(process.env, false)
    if (warning) console.warn(warning)
    return true
  },
  handler: (args) =>
    Effect.gen(function* () {
      const { githubRun, githubEventContext } = yield* Effect.promise(() => import("./github.handler"))
      // Reviews have their own job, so the event is routed before any task work starts.
      const context = githubEventContext(args)
      const route = routeGithubEvent(context, mentionsFrom(process.env["MENTIONS"], TASK_MENTIONS))
      return yield* githubRun({ ...args, context, route, share: sharing.get(args) })
    }),
})

export const GithubReviewCommand = effectCmd({
  command: "review",
  describe: "review a pull request and post the results",
  builder: (yargs) =>
    yargs
      .option("event", {
        type: "string",
        describe: "GitHub event JSON to review instead of the Actions event",
      })
      .option("pr", {
        type: "number",
        describe: "pull request number to review",
      })
      .option("dry-run", {
        type: "boolean",
        describe: "print every write as JSON instead of posting it",
      }),
  // The pull request's own vector.json, `.vector` agents and plugins, AGENTS.md and .vector/RULES.md never configure
  // the reviewer, whatever the workflow file sets: both flags are on before the instance loads any of them.
  instance: () => {
    const warning = prepareGithubEnvironment(process.env, true)
    if (warning) console.warn(warning)
    return true
  },
  handler: (args) =>
    Effect.gen(function* () {
      const { githubReview } = yield* Effect.promise(() => import("./github.review"))
      return yield* githubReview({ event: args.event, pr: args.pr, dryRun: args["dry-run"] })
    }),
})

export const GithubCommand = cmd({
  command: "github",
  describe: "manage GitHub agent",
  builder: (yargs) =>
    yargs.command(GithubInstallCommand).command(GithubRunCommand).command(GithubReviewCommand).demandCommand(),
  async handler() {},
})
