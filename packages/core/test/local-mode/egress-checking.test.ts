import { afterEach, describe, expect, test } from "bun:test"
import { Egress } from "../../src/local-mode/egress"
import { LocalPolicy } from "../../src/local-mode/policy"
import { LocalProbe } from "../../src/local-mode/probe"
import { NetworkGuard } from "../lib/network-guard"

// Add server reads a server the owner typed in before it is on the list. Egress.checking lets the server check's
// requests to that origin through while it runs, where allowing the source would, and nothing else. Every case here
// is a decision; nothing connects.

NetworkGuard.use()

afterEach(async () => {
  Egress.configure(LocalPolicy.OFF)
  await Egress.erase()
})

const GPU = "http://gpu.lan:8000"
const on = (web: "ask" | "network" | "none" = "ask") =>
  Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web, endpoints: ["http://127.0.0.1:11434"] } }))
const read = (url: string) => Egress.decide({ source: LocalProbe.SERVER_CHECK, url })

describe("Egress.checking", () => {
  test("lets the server check read the typed server while it runs, and only then", async () => {
    on()
    expect(read(`${GPU}/api/version`).decision).toBe("block")
    const during = await Egress.checking(LocalProbe.SERVER_CHECK, GPU, async () => read(`${GPU}/api/version`))
    expect(during).toMatchObject({ decision: "allow", rule: "allowed-source" })
    // The log says why it went.
    expect(during.event).toMatchObject({ decision: "allow", origin: GPU, reason: "You asked Vector to read this server." })
    expect(read(`${GPU}/api/tags`).decision).toBe("block")
  })

  test("lets no other origin through, and no other source to the same origin", async () => {
    on()
    await Egress.checking(LocalProbe.SERVER_CHECK, GPU, async () => {
      expect(read("http://other.lan:8000/api/version").decision).toBe("block")
      expect(read("http://gpu.lan:9000/api/version").decision).toBe("block")
      expect(Egress.decide({ source: "mcp-remote", url: `${GPU}/mcp` }).decision).toBe("block")
      // Model calls go only to listed servers, checking or not.
      expect(Egress.decide({ source: "local-inference", url: `${GPU}/v1/chat/completions` }).decision).toBe("block")
    })
  })

  test("keeps an internet server blocked with Web access None", async () => {
    on("none")
    const during = await Egress.checking(LocalProbe.SERVER_CHECK, "https://models.example.com", async () =>
      read("https://models.example.com/v1/models"),
    )
    expect(during).toMatchObject({ decision: "block", rule: "web-none" })
  })

  test("still lets the check through after another check of the same origin ends", async () => {
    on()
    const first = Promise.withResolvers<void>()
    const outer = Egress.checking(LocalProbe.SERVER_CHECK, GPU, () => first.promise.then(() => read(`${GPU}/v1/models`)))
    await Egress.checking(LocalProbe.SERVER_CHECK, GPU, async () => undefined)
    first.resolve()
    expect((await outer).decision).toBe("allow")
    expect(read(`${GPU}/v1/models`).decision).toBe("block")
  })

  test("ends the allowance when the check fails", async () => {
    on()
    await expect(
      Egress.checking(LocalProbe.SERVER_CHECK, GPU, async () => {
        throw new Error("no answer")
      }),
    ).rejects.toThrow("no answer")
    expect(read(`${GPU}/api/version`).decision).toBe("block")
  })
})
