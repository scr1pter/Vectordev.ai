import { describe, expect, test } from "bun:test"
import {
  announcesServerStatus,
  authenticationStartsOpen,
  authenticationSummary,
  CLI_SERVER_USERNAME,
  createPreviewScheduler,
  DEFAULT_SERVER_USERNAME,
  looksLikeServerAddress,
  SERVER_FORM_COPY,
  serverFormCopy,
  serverFormStatus,
  serverFormSubmitState,
  serverNamePlaceholder,
  splitOptionalLabel,
  templateParts,
} from "./server-form-model"

const base = { value: "http://localhost:4096", error: "", checking: false, status: undefined }

describe("looksLikeServerAddress", () => {
  test("waits for something that names a host and port or domain", () => {
    expect(looksLikeServerAddress("")).toBe(false)
    expect(looksLikeServerAddress("   ")).toBe(false)
    expect(looksLikeServerAddress("my")).toBe(false)
    expect(looksLikeServerAddress("myserver")).toBe(false)
  })

  test("ignores a scheme that is still being typed, or a port with no host", () => {
    for (const partial of ["http:", "http:/", "http://", "https://", "https:/", "HTTP://", ":4096"]) {
      expect(looksLikeServerAddress(partial)).toBe(false)
    }
  })

  test("accepts local hosts, ports and domains", () => {
    expect(looksLikeServerAddress("localhost")).toBe(true)
    expect(looksLikeServerAddress("localhost:")).toBe(true)
    expect(looksLikeServerAddress("http://localhost:4096")).toBe(true)
    expect(looksLikeServerAddress("127.0.0.1")).toBe(true)
    expect(looksLikeServerAddress("myserver:4096")).toBe(true)
    expect(looksLikeServerAddress("https://box.example.com/")).toBe(true)
  })
})

describe("serverFormStatus", () => {
  test("is idle until the address looks complete", () => {
    expect(serverFormStatus({ ...base, value: "" })).toBe("idle")
    expect(serverFormStatus({ ...base, value: "my", status: true })).toBe("idle")
    expect(serverFormStatus({ ...base, value: "http://", checking: true })).toBe("idle")
    expect(serverFormStatus(base)).toBe("idle")
  })

  test("shows a running preview as checking", () => {
    expect(serverFormStatus({ ...base, checking: true })).toBe("checking")
  })

  test("shows the preview result", () => {
    expect(serverFormStatus({ ...base, status: true })).toBe("reachable")
    expect(serverFormStatus({ ...base, status: false })).toBe("unreachable")
  })

  test("a failed save wins over the preview", () => {
    expect(serverFormStatus({ ...base, status: true, error: "Could not connect to server" })).toBe("error")
    expect(serverFormStatus({ ...base, checking: true, error: "Could not connect to server" })).toBe("error")
  })

  test("a refused empty submit asks for an address until one is typed", () => {
    expect(serverFormStatus({ ...base, value: "", required: true })).toBe("required")
    expect(serverFormStatus({ ...base, value: "   ", required: true })).toBe("required")
    expect(serverFormStatus({ ...base, required: true, status: true })).toBe("reachable")
    expect(serverFormStatus({ ...base, value: "", required: true, error: "Could not connect to server" })).toBe("error")
  })
})

describe("announcesServerStatus", () => {
  test("announces settled results, not the helper or a running check", () => {
    expect(announcesServerStatus("idle")).toBe(false)
    expect(announcesServerStatus("checking")).toBe(false)
    for (const status of ["reachable", "unreachable", "error", "required"] as const) {
      expect(announcesServerStatus(status)).toBe(true)
    }
  })
})

describe("serverFormSubmitState", () => {
  test("needs an address", () => {
    expect(serverFormSubmitState({ value: "", busy: false })).toEqual({ disabled: true, reason: "empty" })
    expect(serverFormSubmitState({ value: "   ", busy: false })).toEqual({ disabled: true, reason: "empty" })
  })

  test("is disabled while the save's check runs", () => {
    expect(serverFormSubmitState({ value: "localhost:4096", busy: true })).toEqual({ disabled: true, reason: "busy" })
    expect(serverFormSubmitState({ value: "", busy: true })).toEqual({ disabled: true, reason: "busy" })
  })

  test("is enabled with any address, complete-looking or not", () => {
    expect(serverFormSubmitState({ value: "localhost:4096", busy: false })).toEqual({ disabled: false })
    expect(serverFormSubmitState({ value: "myserver", busy: false })).toEqual({ disabled: false })
  })
})

describe("authenticationStartsOpen", () => {
  test("add mode starts collapsed with only the default username", () => {
    expect(authenticationStartsOpen({ mode: "add", username: DEFAULT_SERVER_USERNAME, password: "" })).toBe(false)
    expect(authenticationStartsOpen({ mode: "add", username: "", password: "" })).toBe(false)
  })

  test("add mode opens for a password or a non-default username", () => {
    expect(authenticationStartsOpen({ mode: "add", username: DEFAULT_SERVER_USERNAME, password: "x" })).toBe(true)
    expect(authenticationStartsOpen({ mode: "add", username: "opencode", password: "" })).toBe(true)
  })

  test("edit mode opens whenever the server has credentials", () => {
    expect(authenticationStartsOpen({ mode: "edit", username: "", password: "" })).toBe(false)
    expect(authenticationStartsOpen({ mode: "edit", username: DEFAULT_SERVER_USERNAME, password: "" })).toBe(true)
    expect(authenticationStartsOpen({ mode: "edit", username: "", password: "x" })).toBe(true)
  })
})

describe("authenticationSummary", () => {
  test("says whether a password is set, and for which username", () => {
    expect(authenticationSummary({ username: DEFAULT_SERVER_USERNAME, password: "" })).toEqual({ password: false })
    expect(authenticationSummary({ username: "", password: "x" })).toEqual({ password: true })
    expect(authenticationSummary({ username: "vector", password: "x" })).toEqual({ username: "vector", password: true })
  })
})

describe("splitOptionalLabel", () => {
  test("splits a trailing parenthetical off the label", () => {
    expect(splitOptionalLabel("Username (optional)")).toEqual({ text: "Username", hint: "optional" })
    expect(splitOptionalLabel("Nom d'utilisateur (optionnel)")).toEqual({ text: "Nom d'utilisateur", hint: "optionnel" })
  })

  test("handles full-width brackets", () => {
    expect(splitOptionalLabel("服务器名称（可选）")).toEqual({ text: "服务器名称", hint: "可选" })
  })

  test("leaves other labels alone", () => {
    expect(splitOptionalLabel("Server address")).toEqual({ text: "Server address" })
    expect(splitOptionalLabel("(optional)")).toEqual({ text: "(optional)" })
    expect(splitOptionalLabel("Name ()")).toEqual({ text: "Name ()" })
  })
})

describe("serverNamePlaceholder", () => {
  test("previews the name a blank field falls back to", () => {
    expect(serverNamePlaceholder("", "Localhost")).toBe("Localhost")
    expect(serverNamePlaceholder("localhost:4096", "Localhost")).toBe("localhost:4096")
    expect(serverNamePlaceholder("https://box.example.com/", "Localhost")).toBe("box.example.com")
  })
})

describe("templateParts", () => {
  test("splits a sentence around its tokens", () => {
    expect(templateParts("Use {{desktop}}, or {{cli}}.")).toEqual([
      { text: "Use " },
      { token: "desktop" },
      { text: ", or " },
      { token: "cli" },
      { text: "." },
    ])
  })

  test("leaves plain text and single braces alone", () => {
    expect(templateParts("No tokens")).toEqual([{ text: "No tokens" }])
    expect(templateParts("{{a}}")).toEqual([{ token: "a" }])
    expect(templateParts("a {b} c")).toEqual([{ text: "a {b} c" }])
  })
})

describe("serverFormCopy", () => {
  test("is English-only until the strings are in the dictionaries", () => {
    expect(serverFormCopy("en")).toBe(SERVER_FORM_COPY)
    expect(serverFormCopy("fr")).toBeUndefined()
    expect(serverFormCopy("zh")).toBeUndefined()
  })

  test("the credentials hint places both default usernames", () => {
    const tokens = templateParts(SERVER_FORM_COPY.authHint).flatMap((part) => ("token" in part ? [part.token] : []))
    expect(tokens).toEqual(["desktop", "cli"])
    expect(DEFAULT_SERVER_USERNAME).toBe("vector")
    expect(CLI_SERVER_USERNAME).toBe("opencode")
  })
})

function fakeTimers() {
  const pending = new Map<number, () => void>()
  const delays: number[] = []
  let next = 1
  return {
    delays,
    pending,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++
        pending.set(id, fn)
        delays.push(ms)
        return id
      },
      clearTimeout: (id: unknown) => {
        pending.delete(id as number)
      },
    },
    flush() {
      const fns = [...pending.values()]
      pending.clear()
      for (const fn of fns) fn()
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe("createPreviewScheduler", () => {
  test("waits for typing to pause, then runs only the latest check", async () => {
    const clock = fakeTimers()
    const scheduler = createPreviewScheduler({ delayMs: 350, timers: clock.timers })
    const runs: string[] = []
    const applied: string[] = []
    scheduler.schedule(
      () => (runs.push("a"), Promise.resolve("a")),
      (value) => applied.push(value),
    )
    scheduler.schedule(
      () => (runs.push("b"), Promise.resolve("b")),
      (value) => applied.push(value),
    )
    expect(clock.pending.size).toBe(1)
    expect(clock.delays).toEqual([350, 350])
    clock.flush()
    await Promise.resolve()
    await Promise.resolve()
    expect(runs).toEqual(["b"])
    expect(applied).toEqual(["b"])
  })

  test("drops a slower older result that lands after a newer check started", async () => {
    const clock = fakeTimers()
    const scheduler = createPreviewScheduler({ delayMs: 10, timers: clock.timers })
    const older = deferred<string>()
    const applied: string[] = []
    scheduler.schedule(() => older.promise, (value) => applied.push(value))
    clock.flush()
    scheduler.schedule(() => Promise.resolve("newer"), (value) => applied.push(value))
    clock.flush()
    await Promise.resolve()
    await Promise.resolve()
    older.resolve("older")
    await older.promise
    await Promise.resolve()
    expect(applied).toEqual(["newer"])
  })

  test("cancel stops a pending or in-flight check from applying", async () => {
    const clock = fakeTimers()
    const scheduler = createPreviewScheduler({ delayMs: 10, timers: clock.timers })
    const applied: string[] = []
    scheduler.schedule(() => Promise.resolve("pending"), (value) => applied.push(value))
    scheduler.cancel()
    expect(clock.pending.size).toBe(0)
    const inflight = deferred<string>()
    scheduler.schedule(() => inflight.promise, (value) => applied.push(value))
    clock.flush()
    scheduler.cancel()
    inflight.resolve("inflight")
    await inflight.promise
    await Promise.resolve()
    expect(applied).toEqual([])
  })

  test("a rejected check applies nothing", async () => {
    const clock = fakeTimers()
    const scheduler = createPreviewScheduler({ delayMs: 10, timers: clock.timers })
    const applied: string[] = []
    scheduler.schedule(() => Promise.reject(new Error("boom")), (value: string) => applied.push(value))
    clock.flush()
    await Promise.resolve()
    await Promise.resolve()
    expect(applied).toEqual([])
  })
})
