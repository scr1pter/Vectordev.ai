import type { ServerReadyData } from "../preload/types"

// The posting check from desktop main (section 6.4a): before Vector posts a pull request or a review, or makes a
// commit, the engine compares the text with what Vector knows about the owner, over its owner-only route. Desktop main
// has no brain and does not know what a session recalled, so it cannot run the check alone. Text Vector wrote loses
// what repeats the owner's memory, after the owner sees what goes; text the user typed is only asked about. When the
// check cannot run, the owner is asked whether to post anyway.

/** A question with buttons, answered with the button's index; Electron's message box outside tests. */
export type Ask = (input: {
  message: string
  detail?: string
  buttons: string[]
  /** The button Escape and closing the box answer with. */
  cancel: number
  /** The button Return answers with. */
  default: number
}) => Promise<number>

export type Post = {
  /** The repository the text is about, which picks the engine's instance and the brain's place. */
  cwd: string
  /** Everything the post sends, in order: a title and body, or a review's body, its line comments and fallback. */
  parts: string[]
  /** The user typed or edited the text: it is never changed, only asked about. */
  typed: boolean
  /** Sessions whose recalled memory counts too, with the sessions they launched. */
  sessionIDs?: string[]
  /** A pull request from someone Vector cannot trust: its links and images then point only at GitHub. */
  untrusted?: boolean
}

type Result = {
  status: "clean" | "changed" | "ask"
  parts: string[]
  dropped: { part: number; text: string }[]
  links: number
}

const TIMEOUT_MS = 30_000
const SHOWN = 6

const state: { engine?: () => Promise<ServerReadyData>; ask: Ask } = { ask: electronAsk }

/** Where the engine is once it has started, and how to ask the owner (tests give their own). */
export function usePostingEngine(engine: () => Promise<ServerReadyData>, ask?: Ask) {
  state.engine = engine
  if (ask) state.ask = ask
}

/** The parts to post once the check has run and the owner has answered, or undefined when nothing is posted. */
export async function checkPost(input: Post): Promise<string[] | undefined> {
  const result = await request(input).catch(() => undefined)
  if (!result) {
    const choice = await state.ask({
      message: "Vector could not check this text against your memory. Post anyway?",
      buttons: ["Post anyway", "Cancel"],
      cancel: 1,
      default: 1,
    })
    return choice === 0 ? input.parts : undefined
  }
  if (result.status === "clean" || (result.status === "changed" && result.dropped.length === 0)) return result.parts
  const detail = shown(result.dropped)
  if (result.status === "ask") {
    const choice = await state.ask({
      message: `Your text repeats what Vector knows about you in ${count(result.dropped.length)}.`,
      detail,
      buttons: ["Post as is", "Cancel"],
      cancel: 1,
      default: 1,
    })
    return choice === 0 ? input.parts : undefined
  }
  const choice = await state.ask({
    message: `Vector took out ${count(result.dropped.length)} that repeat what it knows about you.`,
    detail,
    buttons: [result.dropped.length === 1 ? "Post without it" : "Post without them", "Post as is", "Cancel"],
    cancel: 2,
    default: 0,
  })
  if (choice === 0) return result.parts
  return choice === 1 ? input.parts : undefined
}

async function request(input: Post): Promise<Result> {
  const engine = await state.engine?.()
  if (!engine) throw new Error("The engine has not started.")
  const url = new URL("/memory/posting-check", engine.url)
  url.searchParams.set("directory", input.cwd)
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(engine.password
        ? {
            authorization: `Basic ${Buffer.from(`${engine.username ?? "vector"}:${engine.password}`).toString("base64")}`,
          }
        : {}),
    },
    body: JSON.stringify({
      parts: input.parts,
      typed: input.typed,
      ...(input.sessionIDs?.length ? { sessionIDs: input.sessionIDs } : {}),
      ...(input.untrusted ? { untrusted: true } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`The posting check failed (${response.status}).`)
  const value: unknown = await response.json()
  if (!readable(value, input.parts.length)) throw new Error("The posting check answered in a shape Vector does not know.")
  return value
}

// The engine is ours, but an answer that does not fit would post the wrong parts, so it is checked before it is used.
function readable(value: unknown, parts: number): value is Result {
  if (!value || typeof value !== "object") return false
  const result = value as Partial<Result>
  return (
    (result.status === "clean" || result.status === "changed" || result.status === "ask") &&
    Array.isArray(result.parts) &&
    result.parts.length === parts &&
    result.parts.every((part) => typeof part === "string") &&
    Array.isArray(result.dropped) &&
    typeof result.links === "number"
  )
}

function shown(dropped: Result["dropped"]) {
  const lines = dropped.slice(0, SHOWN).map((item) => `• ${item.text.length > 200 ? `${item.text.slice(0, 199)}…` : item.text}`)
  return dropped.length > SHOWN ? [...lines, `…and ${dropped.length - SHOWN} more`].join("\n") : lines.join("\n")
}

function count(sentences: number) {
  return sentences === 1 ? "1 sentence" : `${sentences} sentences`
}

async function electronAsk(input: Parameters<Ask>[0]) {
  const { BrowserWindow, dialog } = await import("electron")
  const options = {
    type: "question" as const,
    message: input.message,
    ...(input.detail ? { detail: input.detail } : {}),
    buttons: input.buttons,
    defaultId: input.default,
    cancelId: input.cancel,
    noLink: true,
  }
  const window = BrowserWindow.getFocusedWindow()
  const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return answer.response
}
