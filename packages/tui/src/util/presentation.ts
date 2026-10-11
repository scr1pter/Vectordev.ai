import { logo } from "../logo"
import stripAnsi from "strip-ansi"

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

export function sanitizeTerminalText(text: string) {
  return stripAnsi(text).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
}

function wordmark(pad = "") {
  const draw = (line: string, fg: string, shadow: string, bg: string) =>
    [...line]
      .map((char) => {
        if (char === "_") return `${bg} ${reset}`
        if (char === "^") return `${fg}${bg}▀${reset}`
        if (char === "~") return `${shadow}▀${reset}`
        if (char === " ") return " "
        return `${fg}${char}${reset}`
      })
      .join("")

  return logo.left.map((line, index) => {
    const left = draw(line, dim, "\x1b[38;5;235m", "\x1b[48;5;235m")
    const right = draw(logo.right[index] ?? "", reset, "\x1b[38;5;238m", "\x1b[48;5;238m")
    return `${pad}${left} ${right}`
  })
}

export function sessionEpilogue(input: { title: string; sessionID?: string }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  const title = sanitizeTerminalText(input.title)
  const sessionID = sanitizeTerminalText(input.sessionID ?? "")
  return [
    ...wordmark("  "),
    "",
    `  ${weak("Session")}${bold}${title}${reset}`,
    `  ${weak("Continue")}${bold}vector -s ${sessionID}${reset}`,
    "",
  ].join("\n")
}
