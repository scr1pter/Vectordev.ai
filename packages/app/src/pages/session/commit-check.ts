// The posting check for a commit message the owner types (section 6.4a). A commit is checked when it is made, since
// nothing posts its message later. The message is the user's own, so it is never changed: the engine compares it with
// what Vector knows about them, and when it repeats some of that, or the check cannot run, the owner decides before
// anything is committed.

export type CommitCheck =
  | { readonly status: "clean" }
  | { readonly status: "ask"; readonly sentences: readonly string[] }
  | { readonly status: "unchecked" }

/** The engine's posting check, as the SDK client calls it. */
export type PostingCheck = (input: {
  memoryPostingPayload: { parts: string[]; typed: boolean }
}) => Promise<{ data?: { status: string; dropped: readonly { text: string }[] }; error?: unknown }>

/** Sentences shown at most; the rest are counted. */
export const SHOWN = 6

export async function checkCommitMessage(message: string, check: PostingCheck): Promise<CommitCheck> {
  const result = await check({ memoryPostingPayload: { parts: [message], typed: true } }).catch(() => undefined)
  if (!result?.data || result.error) return { status: "unchecked" }
  if (result.data.status === "clean") return { status: "clean" }
  return { status: "ask", sentences: result.data.dropped.map((item) => item.text) }
}

/** What the dialog says before the owner commits anyway. */
export function commitWarning(result: Exclude<CommitCheck, { status: "clean" }>) {
  if (result.status === "unchecked")
    return { title: "Vector could not check this message against your memory.", sentences: [], button: "Commit anyway" }
  const count = result.sentences.length
  return {
    title: `Your message repeats what Vector knows about you in ${count === 1 ? "1 sentence" : `${count} sentences`}.`,
    sentences: [
      ...result.sentences.slice(0, SHOWN).map((sentence) => (sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence)),
      ...(count > SHOWN ? [`…and ${count - SHOWN} more`] : []),
    ],
    button: "Commit as is",
  }
}
