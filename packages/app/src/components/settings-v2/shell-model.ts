/** A shell the server can run, as `pty.shells` lists it. */
export type ShellOption = {
  path: string
  name: string
  /** False for a shell agent tool calls will not use (fish, nu), which the picker marks terminal only. */
  acceptable: boolean
}

export type ShellSelectOption = {
  id: string
  /** What is saved as the config's `shell`; the empty string is Auto. */
  value: string
  label: string
}

/**
 * The Terminal Shell picker's options: Auto first, then each listed shell by name, or by path where two share a name,
 * and last the saved shell when the list does not have it, so the picker never shows a different one.
 */
export function shellSelectOptions(input: {
  shells: readonly ShellOption[]
  current: string | undefined
  auto: string
  terminalOnly: string
}): ShellSelectOption[] {
  const nameCounts = new Map<string, number>()
  for (const shell of input.shells) nameCounts.set(shell.name, (nameCounts.get(shell.name) ?? 0) + 1)

  const options: ShellSelectOption[] = [
    { id: "auto", value: "", label: input.auto },
    ...input.shells.map((shell) => {
      const ambiguousName = (nameCounts.get(shell.name) ?? 0) > 1
      const text = ambiguousName ? shell.path : shell.name
      return {
        id: shell.path,
        // Prefer the name over the path: "bash" is much cleaner than its full route, even though PATH can change it.
        value: text,
        label: shell.acceptable ? text : `${text} (${input.terminalOnly})`,
      }
    }),
  ]

  if (input.current && !options.some((option) => option.value === input.current))
    options.push({ id: input.current, value: input.current, label: input.current })

  return options
}

/** The option for the saved shell, or Auto when none is saved. */
export function selectedShellOption(options: readonly ShellSelectOption[], current: string) {
  return options.find((option) => option.value === current) ?? options[0]!
}
