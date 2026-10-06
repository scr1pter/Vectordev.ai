// The app screens the landing page redraws: the agent session in the hero,
// and the browser and Agent Dashboard in the "Inside the app" section. Heights
// are the stage's at the app's width, under 1313px and under 900px; turn and
// task are the seconds on the session's clocks.
type Frame = {
  id: string
  kicker: string
  bar: string
  height: number
  mid: number
  compact: number
}

export type Shot = Frame & ({ variant: "dashboard" } | { variant: "session" | "browser"; turn: number; task: number })

export const sessionShot: Shot = {
  id: "shot-session",
  kicker: "Agent session",
  bar: "Vector — Session",
  // Taller when narrower, so the transcript, which wraps onto more lines
  // and gains a row for its cost, still fits without scrolling.
  height: 770,
  mid: 824,
  compact: 880,
  variant: "session",
  turn: 549,
  task: 533,
}

export const sectionShots: (Shot & { title: string; text: string })[] = [
  {
    id: "shot-browser",
    kicker: "Built-in browser",
    title: "A browser beside the conversation.",
    text: "Vector opens pages in a panel next to the session, so the agent can load your app while you watch it. Go back, reload, or type a path: the pages here are small drawings of this site.",
    bar: "Vector — Browser",
    height: 770,
    mid: 770,
    compact: 770,
    variant: "browser",
    turn: 143,
    task: 728,
  },
  {
    id: "shot-dashboard",
    kicker: "Agent Dashboard",
    title: "Every workspace on one board.",
    text: "Each isolated workspace you start lands here with its live status, the files it touched and its pull request. Search, filter by status, runtime or pull request, or switch the board to a list.",
    bar: "Vector — Agent Dashboard",
    height: 322,
    mid: 322,
    compact: 362,
    variant: "dashboard",
  },
]
