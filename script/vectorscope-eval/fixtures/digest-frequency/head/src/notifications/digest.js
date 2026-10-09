/**
 * @typedef {object} Member
 * @property {string} id
 * @property {string} name
 * @property {string} email
 * @property {{ email?: string, digest: "daily" | "weekly" | "off" } | undefined} preferences
 *   Undefined until the member saves their notification settings for the first time.
 */

/**
 * @typedef {object} Activity
 * @property {string} memberId who did it
 * @property {string} kind
 * @property {string} summary
 * @property {Date} at
 */

const MAX_ITEMS = 25

/**
 * One digest per member who wants one at this frequency: what everyone else in the workspace did since `since`.
 * Members who have not saved their settings yet get the weekly digest, as before this change. Members with nothing
 * to read get no digest.
 * @param {Member[]} members
 * @param {Activity[]} activity
 * @param {"daily" | "weekly"} frequency
 * @param {Date} since
 */
export function buildDigests(members, activity, frequency, since) {
  const recent = activity.filter((item) => item.at >= since).sort((a, b) => b.at.getTime() - a.at.getTime())
  return members
    .filter((member) => member.preferences.digest === frequency)
    .map((member) => {
      const items = recent.filter((item) => item.memberId !== member.id)
      return {
        to: member.preferences?.email ?? member.email,
        name: member.name,
        frequency,
        items: items.slice(0, MAX_ITEMS),
        more: Math.max(0, items.length - MAX_ITEMS),
      }
    })
    .filter((digest) => digest.items.length > 0)
}
