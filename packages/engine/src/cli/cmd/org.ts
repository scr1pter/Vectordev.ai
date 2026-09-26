import { cmd } from "./cmd"
import { UI } from "../ui"

export const OrgCommand = cmd({
  command: "org",
  describe: "manage Vector Teams and Personal workspace",
  builder: (yargs) =>
    yargs
      .command({
        command: "list",
        describe: "list verified Vector Teams memberships",
        handler: async () => {
          const { VectorTeams } = await import("@/teams")
          const status = await VectorTeams.runtime.runPromise((teams) => teams.refresh())
          UI.println(`${status.active ? " " : "*"} Personal workspace`)
          if (!status.enabled) {
            UI.println('Vector Teams is unavailable or you are not signed in. Run "vector login" and try again.')
            return
          }
          for (const org of status.orgs)
            UI.println(`${status.active?.id === org.id ? "*" : " "} ${org.id}  ${org.name} (${org.role})`)
        },
      })
      .command({
        command: "switch <orgID>",
        describe: "apply a verified team's provider, permission and integration defaults",
        builder: (args) => args.positional("orgID", { type: "string", demandOption: true }),
        handler: async (args) => {
          const { VectorTeams } = await import("@/teams")
          const status = await VectorTeams.runtime.runPromise((teams) => teams.select(args.orgID))
          UI.println(
            `Active team: ${status.active?.name}. Team defaults apply to new sessions and running apps after refresh.`,
          )
        },
      })
      .command({
        command: "personal",
        describe: "leave team configuration and repair local selection, including while offline",
        handler: async () => {
          const { VectorTeams } = await import("@/teams")
          await VectorTeams.runtime.runPromise((teams) => teams.select(null))
          UI.println("Personal workspace selected. Refresh running apps to reload configuration.")
        },
      })
      .demandCommand(),
  handler: () => {},
})
