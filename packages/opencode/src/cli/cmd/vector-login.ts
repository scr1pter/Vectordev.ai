import { cmd } from "./cmd"
import { UI } from "../ui"
import { currentUser, login, signOut } from "../vector-account"

export const VectorLoginCommand = cmd({
  command: "login",
  describe: "sign in to your free Vector account",
  builder: (yargs) =>
    yargs.option("token", {
      type: "string",
      describe: "CLI token from vectordev.ai/auth/cli (skips the interactive prompt)",
    }),
  handler: async (args) => {
    const existing = await currentUser()
    if (existing && !args.token) {
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓ " + UI.Style.TEXT_NORMAL + "Already signed in as " + existing.email)
      UI.println(UI.Style.TEXT_DIM + 'Run "vector logout" first to switch accounts.')
      return
    }
    if (existing && args.token) await signOut()
    const user = await login(args.token)
    if (!user) process.exit(1)
  },
})

export const VectorLogoutCommand = cmd({
  command: "logout",
  describe: "sign out of your Vector account",
  handler: async () => {
    const existing = await currentUser()
    await signOut()
    UI.println(
      existing ? `Signed out ${existing.email}.` : "No Vector account was signed in on this machine.",
    )
  },
})

export const VectorWhoamiCommand = cmd({
  command: "whoami",
  describe: "show the signed-in Vector account",
  handler: async () => {
    const existing = await currentUser()
    if (!existing) {
      UI.println('Not signed in. Run "vector login".')
      process.exitCode = 1
      return
    }
    UI.println(existing.email)
  },
})
