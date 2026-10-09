import { buildDigests } from "../notifications/digest.js"
import { renderDigestEmail } from "../notifications/templates.js"

const DAY_MS = 24 * 60 * 60 * 1000

// Runs from cron every day at 08:00 UTC. Daily digests go out every run, weekly ones on Mondays.
export async function sendDigests({ workspaces, mailer, store, now = new Date() }) {
  const frequencies = now.getUTCDay() === 1 ? ["daily", "weekly"] : ["daily"]
  let sent = 0
  for (const workspace of workspaces) {
    const members = await store.members(workspace.id)
    for (const frequency of frequencies) {
      const since = new Date(now.getTime() - (frequency === "daily" ? DAY_MS : 7 * DAY_MS))
      const activity = await store.activity(workspace.id, { since })
      for (const digest of buildDigests(members, activity, frequency, since)) {
        await mailer.send({
          to: digest.to,
          subject: `Your ${frequency} ${workspace.name} digest`,
          html: renderDigestEmail(digest),
        })
        sent++
      }
    }
  }
  return { sent }
}
