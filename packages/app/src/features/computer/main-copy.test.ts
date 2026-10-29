import { describe, expect, test } from "bun:test"
import type { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { dict } from "@vectordevai/ui/i18n/en"
import { ComputerMainCopy } from "./main-copy"

const samples = [
  ["banner", () => ComputerMainCopy.banner(), Hands.BANNER],
  ["bannerEnd", () => ComputerMainCopy.bannerEnd({ reason: "done" }), "Done — your computer is yours again"],
  ["trayTooltip", () => ComputerMainCopy.trayTooltip(), `Vector — ${Hands.BANNER}`],
  ["trayStop", () => ComputerMainCopy.trayStop(), `Stop ${Hands.NAME}`],
  ["working", () => ComputerMainCopy.working({ app: "Numbers" }), "Working in Numbers"],
  ["workingBehind", () => ComputerMainCopy.workingBehind({ app: "Numbers" }), "Working in Numbers behind your windows"],
  [
    "waitingForTyping",
    () => ComputerMainCopy.waitingForTyping({ app: "Numbers" }),
    "Waiting while you type in Numbers",
  ],
  [
    "foregroundFallback",
    () => ComputerMainCopy.foregroundFallback({ app: "Numbers" }),
    `Numbers needs the screen; ${Hands.NAME} will ask before using your mouse.`,
  ],
  ["queued", () => ComputerMainCopy.queued({ count: 1 }), "+1 waiting"],
  ["notificationStart", () => ComputerMainCopy.notificationStart(), `${Hands.BANNER}. Press Esc or Stop to stop it.`],
  ["notificationNeedsYou", () => ComputerMainCopy.notificationNeedsYou(), `${Hands.NAME} needs you`],
  [
    "notificationFinished",
    () => ComputerMainCopy.notificationFinished({ count: 23, app: "Numbers and Calculator" }),
    `${Hands.NAME} finished. 23 actions in Numbers and Calculator.`,
  ],
  ["notificationStopped", () => ComputerMainCopy.notificationStopped(), `${Hands.NAME} stopped.`],
  [
    "notificationFailed",
    () => ComputerMainCopy.notificationFailed({ reason: "the app closed" }),
    `${Hands.NAME} couldn't finish: the app closed`,
  ],
  ["pause", () => ComputerMainCopy.pause({ reason: "input" }), "Paused — you have control"],
  [
    "secureTypingDetail",
    () => ComputerMainCopy.secureTypingDetail({ app: "Mail" }),
    "Mail turned on secure keyboard entry, so Vector can't hear Esc. Finish typing your password or turn it off, then press Resume.",
  ],
  [
    "checkIn",
    () => ComputerMainCopy.checkIn({ reason: "actions", count: 300 }),
    `${Hands.NAME} has taken 300 steps on this task. Keep going?`,
  ],
  [
    "handoff",
    () => ComputerMainCopy.handoff({ reason: "sign_in", app: "Numbers" }),
    "Your turn in Numbers: sign in. Press Continue when you're done.",
  ],
  [
    "step",
    () => ComputerMainCopy.step({ action: "click", app: "Numbers", label: "Save" }),
    "Clicking “Save” in Numbers",
  ],
] as const

const pauses = {
  input: "Paused — you have control",
  button: "Paused — you have control",
  locked: "Paused while your computer was locked",
  suspend: "Paused while your computer was locked",
  away: `Still there? ${Hands.NAME} paused so your computer can lock.`,
  helper: `Paused — ${Hands.NAME}' helper stopped`,
  detection: "Paused — Vector can't tell whether you're using the mouse and keyboard",
  secure_input: "Paused — secure typing is on in Mail",
  secure_desktop: "Paused — Windows is showing a security screen",
  overlay: "Paused — the screen indicator is unavailable",
  pointer: `${Hands.NAME} needs the mouse for a moment`,
} satisfies Record<Computer.PauseReason, string>

const handoffs = {
  credential: "enter your password or code",
  sign_in: "sign in",
  captcha: "complete the CAPTCHA",
  payment_details: "enter your payment details",
  admin_prompt: "answer the administrator prompt",
  security_prompt: "answer the security prompt",
  capture_confirm: "answer the screen recording prompt",
  elevated: "finish this step in the app running as administrator",
  site_permission: "answer the site's permission prompt",
  download: "decide whether to keep or open the download",
  extension: "decide whether to install the extension",
  protocol_handler: "decide whether to open the linked app",
  macros: "decide whether to enable the document's content or macros",
  other: "finish this step yourself",
} satisfies Record<Computer.HandoffReason, string>

const steps = {
  screenshot: "Looking at Numbers",
  zoom: "Looking more closely at Numbers",
  cursor_position: "Checking the pointer",
  click: "Clicking “Save” in Numbers",
  double_click: "Double-clicking “Save” in Numbers",
  triple_click: "Triple-clicking “Save” in Numbers",
  right_click: "Right-clicking “Save” in Numbers",
  middle_click: "Middle-clicking “Save” in Numbers",
  mouse_move: "Moving the pointer in Numbers",
  drag: "Dragging “Save” in Numbers",
  mouse_down: "Holding the mouse button in Numbers",
  mouse_up: "Releasing the mouse button in Numbers",
  scroll: "Scrolling in Numbers",
  type: "Typing in Numbers",
  key: "Pressing keys in Numbers",
  hold_key: "Holding keys in Numbers",
  wait: "Waiting",
  list_apps: "Looking at available apps",
  open_app: "Opening Numbers",
  focus_window: "Switching to Numbers",
  read_ui: "Reading controls in Numbers",
  handoff: "Your turn",
} satisfies Record<Computer.ToolAction, string>

describe("desktop main copy", () => {
  for (const [name, render, expected] of samples) {
    test(`${name} uses the specified copy`, () => expect(render()).toBe(expected))
  }

  test("every exported function has a sample and the banner is the exact fixed sentence", () => {
    expect(
      Object.entries(ComputerMainCopy)
        .filter(([, value]) => typeof value === "function")
        .map(([name]) => name)
        .sort(),
    ).toEqual(samples.map(([name]) => name).sort())
    expect(ComputerMainCopy.banner()).toBe(Hands.BANNER)
    expect(ComputerMainCopy.banner()).toBe("Vector is using your computer")
  })

  test("completion and check-ins handle singular, plural and absent app names", () => {
    expect(ComputerMainCopy.bannerEnd({ reason: "stopped" })).toBe("Stopped — your computer is yours again")
    expect(ComputerMainCopy.notificationFinished({ count: 1, app: "Numbers" })).toBe(
      `${Hands.NAME} finished. 1 action in Numbers.`,
    )
    expect(ComputerMainCopy.notificationFinished({ count: 0 })).toBe(`${Hands.NAME} finished. 0 actions.`)
    expect(ComputerMainCopy.checkIn({ reason: "minutes", count: 45 })).toBe(
      `${Hands.NAME} has been working for 45 minutes on this task. Keep going?`,
    )
    expect(ComputerMainCopy.checkIn({ reason: "minutes", count: 1 })).toBe(
      `${Hands.NAME} has been working for 1 minute on this task. Keep going?`,
    )
    expect(ComputerMainCopy.checkIn({ reason: "actions", count: 1 })).toBe(
      `${Hands.NAME} has taken 1 step on this task. Keep going?`,
    )
    expect(ComputerMainCopy.queued({ count: 3 })).toBe("+3 waiting")
  })

  test("every pause reason has explicit copy", () => {
    for (const reason of Object.keys(pauses) as Computer.PauseReason[]) {
      expect(ComputerMainCopy.pause({ reason, app: "Mail" })).toBe(pauses[reason])
    }
    expect(ComputerMainCopy.pause({ reason: "secure_input" })).toBe("Paused — secure typing is on in another app")
  })

  test("every handoff reason is fixed copy, with or without an app", () => {
    for (const reason of Object.keys(handoffs) as Computer.HandoffReason[]) {
      expect(ComputerMainCopy.handoff({ reason, app: "Numbers" })).toBe(
        `Your turn in Numbers: ${handoffs[reason]}. Press Continue when you're done.`,
      )
    }
    expect(ComputerMainCopy.handoff({ reason: "other" })).toBe(
      "Your turn: finish this step yourself. Press Continue when you're done.",
    )
  })

  test("every live action uses a Vector-built label", () => {
    for (const action of Object.keys(steps) as Computer.ToolAction[]) {
      expect(ComputerMainCopy.step({ action, app: "Numbers", label: "Save" })).toBe(steps[action])
    }
    expect(ComputerMainCopy.step({ action: "click" })).toBe("Clicking")
    expect(ComputerMainCopy.step({ action: "screenshot" })).toBe("Looking at the approved apps")
    expect(ComputerMainCopy.step({ action: "zoom" })).toBe("Looking more closely")
    expect(ComputerMainCopy.step({ action: "open_app" })).toBe("Opening an app")
    expect(ComputerMainCopy.step({ action: "focus_window" })).toBe("Switching windows")
    expect(ComputerMainCopy.step({ action: "read_ui" })).toBe("Reading app controls")
  })

  test("live labels strip control characters and cap quoted accessibility text", () => {
    expect(ComputerMainCopy.step({ action: "click", app: "Numbers", label: "\u202eSave\u200b\n\u0085" })).toBe(
      "Clicking “Save” in Numbers",
    )
    expect(ComputerMainCopy.step({ action: "click", label: "A".repeat(60) })).toBe(`Clicking “${"A".repeat(40)}”`)
    expect(ComputerMainCopy.step({ action: "click", label: "“Save”" })).toBe('Clicking “"Save"”')
  })

  test("model intent, typed text and key payloads never enter live labels", () => {
    const input = {
      action: "type" as const,
      app: "Numbers",
      intent: "Agent-authored instruction",
      text: { preview: "Private text" },
      keys: "Private keys",
    }
    expect(ComputerMainCopy.step(input)).toBe("Typing in Numbers")
  })

  test("fixed controls and statuses use the specified labels", () => {
    expect(ComputerMainCopy.labels).toEqual({
      takeOver: "Take over",
      resume: "Resume",
      stop: "Stop",
      allow: "Allow",
      allowOnce: "Allow once",
      deny: "Deny",
      continue: "Continue",
      handOver: "Hand over",
      notNow: "Not now",
      keepGoing: "Keep going",
      working: "Working",
      needsYou: "Needs you",
      paused: "Paused",
      waiting: "Waiting for the computer",
      yourTurn: "Your turn",
      done: "Done",
      stopped: "Stopped",
    })
  })

  test("main and timeline copy never use the old feature phrase", () => {
    const outputs = [
      ...samples.map(([, render]) => render()),
      ...Object.values(ComputerMainCopy.labels),
      ...Object.keys(pauses).map((reason) => ComputerMainCopy.pause({ reason: reason as Computer.PauseReason })),
      ...Object.keys(handoffs).map((reason) => ComputerMainCopy.handoff({ reason: reason as Computer.HandoffReason })),
      ...Object.keys(steps).map((action) => ComputerMainCopy.step({ action: action as Computer.ToolAction })),
      ...Object.entries(dict).flatMap(([key, value]) => (key.startsWith("ui.tool.computer.") ? [value] : [])),
    ]
    for (const output of outputs) expect(output).not.toMatch(/computer use/i)
  })
})

test("timeline copy includes every required step and uses the name placeholder", () => {
  const required = {
    looked: "Looked at {{app}}",
    clicked: "Clicked “{{target}}” in {{app}}",
    doubleClicked: "Double-clicked “{{target}}” in {{app}}",
    rightClicked: "Right-clicked “{{target}}” in {{app}}",
    typed: "Typed “{{text}}” in {{app}}",
    pressed: "Pressed {{keys}}",
    scrolled: "Scrolled {{direction}}",
    dragged: "Dragged in {{app}}",
    opened: "Opened {{app}}",
    switched: "Switched to {{app}}",
    read: "Read controls in {{app}}",
    waited: "Waited {{seconds}} s",
    yourTurn: "Your turn in {{app}}: {{reason}}",
    tookOver: "You took over ({{duration}})",
    resumed: "Resumed",
    blocked: "Couldn't use {{app}}: {{reason}}",
    screenshotRemoved: "Screenshot removed",
  }
  for (const [key, value] of Object.entries(required)) expect(dict[`ui.tool.computer.${key}`]).toBe(value)
  for (const key of [
    "name",
    "run",
    "blocked.terminal",
    "blocked.vector",
    "blocked.password",
    "blocked.security",
    "blocked.remote",
    "blocked.user",
    "blocked.company",
  ])
    expect(dict[`ui.tool.computer.${key}`]).toContain("{{name}}")
  for (const [key, value] of Object.entries(dict)) {
    if (key.startsWith("ui.tool.computer.")) expect(value).not.toContain(Hands.NAME)
  }
})
