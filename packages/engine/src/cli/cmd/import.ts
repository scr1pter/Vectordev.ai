import { CliError, effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { EOL } from "os"
import { FSUtil } from "@vectordevai/core/fs-util"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { Location } from "@vectordevai/core/location"
import { AbsolutePath } from "@vectordevai/core/schema"
import { Effect, Schema } from "effect"
import { PublicSession } from "@vectordevai/schema/public-session"

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import a local session archive or a public Vector share without running its history",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "local JSON file or https://vectordev.ai/s/<id>",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    const fs = yield* FSUtil.Service
    const shares = yield* PublicSessionShare.Service
    const archive = /^[a-z][a-z0-9+.-]*:\/\//i.test(args.file)
      ? yield* shares.read(args.file).pipe(Effect.mapError((error) => new CliError({ message: error.message })))
      : yield* fs.readJson(args.file).pipe(Effect.orElseSucceed(() => undefined))
    if (!archive) return yield* new CliError({ message: `Could not read session JSON file: ${args.file}` })
    const portable = Schema.is(PublicSession.Archive)(archive) ? archive : undefined
    const imported = yield* shares
      .import({
        archive,
        ...(portable ? { targetEngine: "v1" as const } : {}),
        location: Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }),
      })
      .pipe(Effect.mapError((error) => new CliError({ message: error.message })))
    process.stdout.write(`Imported session: ${imported.sessionID}${EOL}`)
    if (portable && portable.engine !== imported.engine)
      process.stdout.write(
        `Imported portable ${portable.engine} transcript into ${imported.engine} for the current CLI.${EOL}`,
      )
    if (!portable && imported.engine === "v2")
      process.stdout.write(
        `Native V2 history is available through the native session API. The current CLI conversation view cannot display it.${EOL}`,
      )
  }),
})
