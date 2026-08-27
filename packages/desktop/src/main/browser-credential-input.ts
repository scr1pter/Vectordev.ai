export class CredentialFocusChangedError extends Error {}

export type GuardedInputEvent = {
  type: "keyDown" | "char" | "keyUp"
  keyCode: string
  modifiers: "shift"[]
}

// A page can move focus from a harmless field to a credential field from any
// keyboard-event handler. Check immediately before every event, not merely
// once before the string, so a keydown-driven focus trap never receives the
// following character.
export async function sendGuardedCharacters(
  value: string,
  isCredentialFocused: () => Promise<boolean>,
  send: (event: GuardedInputEvent) => void,
) {
  for (const character of Array.from(value)) {
    const keyCode = character === " " ? "Space" : character === "\n" ? "Enter" : character === "\t" ? "Tab" : character
    const modifiers: "shift"[] = character >= "A" && character <= "Z" ? ["shift"] : []
    for (const type of ["keyDown", "char", "keyUp"] as const) {
      if (await isCredentialFocused()) throw new CredentialFocusChangedError()
      send({ type, keyCode, modifiers })
    }
  }
}
