import { describe, expect, test } from "bun:test"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { parseWslNetwork, wslLocalPolicy } from "./runtime"

// The Vector Local an engine in WSL gets from the desktop (plan section 4.10): user-level policy, never a lock, with the
// servers on this computer listed where the distro reaches them.

const LOCKED = LocalPolicy.resolve({
  managed: {
    lock: true,
    web: "network",
    user_may: ["endpoints"],
    endpoints: ["https://*.ml.corp.example.com", "10.0.0.0/8", "https://llm.corp.example.com"],
    allow: [{ source: "github", reason: "Pull requests", added_at: 1, added_by: "app" }],
    web_domains: { allow: ["docs.corp.example.com"] },
  },
  global: { endpoints: ["http://127.0.0.1:11434"] },
})

describe("how WSL networks a distro", () => {
  test("mirrored networking and WSL 1 share Windows' loopback", () => {
    expect(parseWslNetwork("mode=mirrored\nkernel=5.15.153.1-microsoft-standard-WSL2\n")).toEqual({ mode: "shared" })
    expect(parseWslNetwork("mode=\nkernel=4.4.0-19041-Microsoft\n")).toEqual({ mode: "shared" })
  })

  test("NAT networking reaches Windows at the default gateway", () => {
    expect(
      parseWslNetwork(
        "mode=nat\r\nkernel=5.15.153.1-microsoft-standard-WSL2\r\ndefault via 172.29.16.1 dev eth0 proto kernel\r\n",
      ),
    ).toEqual({ mode: "nat", gateway: "172.29.16.1" })
    // WSL 2 before wslinfo had NAT only.
    expect(
      parseWslNetwork("mode=\nkernel=5.10.16.3-microsoft-standard-WSL2\ndefault via 172.20.0.1 dev eth0\n"),
    ).toEqual({ mode: "nat", gateway: "172.20.0.1" })
  })

  test("a gateway that is not a private address is not taken for Windows, and a silent distro is unknown", () => {
    expect(
      parseWslNetwork("mode=nat\nkernel=5.15.153.1-microsoft-standard-WSL2\ndefault via 203.0.113.9 dev eth0\n"),
    ).toEqual({ mode: "nat" })
    expect(parseWslNetwork("")).toEqual({ mode: "unknown" })
    expect(parseWslNetwork("mode=virtioproxy\nkernel=6.6.36.6-microsoft-standard-WSL2\n")).toEqual({
      mode: "unknown",
    })
  })
})

describe("the policy an engine in WSL gets", () => {
  test("is nothing while Vector Local is off", () => {
    expect(wslLocalPolicy(LocalPolicy.OFF, { mode: "nat", gateway: "172.29.16.1" })).toBeUndefined()
  })

  test("carries on, Web access and plain server addresses, and never a lock, allowed services or sites", () => {
    const text = wslLocalPolicy(LOCKED, { mode: "shared" })!
    expect(JSON.parse(text)).toEqual({
      enabled: true,
      web: "network",
      endpoints: ["https://llm.corp.example.com", "http://127.0.0.1:11434"],
    })
    // The engine reads it as the user's own setting: on, as strict, the same servers, and not locked.
    const engine = LocalPolicy.resolve({ env: { VECTOR_LOCAL_POLICY: text } })
    expect(engine).toMatchObject({ enabled: true, web: "network", lock: false, allow: [], user_may: [] })
    expect(engine.endpoints).toEqual([
      { origin: "https://llm.corp.example.com", from: "environment" },
      { origin: "http://127.0.0.1:11434", from: "environment" },
    ])
    expect(engine.warnings).toEqual([])
  })

  test("even forged to say lock, it cannot lock the engine", () => {
    const forged = JSON.stringify({ ...JSON.parse(wslLocalPolicy(LOCKED, { mode: "shared" })!), lock: true })
    expect(LocalPolicy.resolve({ env: { VECTOR_LOCAL_POLICY: forged } }).lock).toBe(false)
  })

  test("in NAT networking, a server on this computer is listed at the Windows host gateway too", () => {
    const text = wslLocalPolicy(LOCKED, { mode: "nat", gateway: "172.29.16.1" })!
    expect(JSON.parse(text).endpoints).toEqual([
      "https://llm.corp.example.com",
      "http://127.0.0.1:11434",
      "http://172.29.16.1:11434",
    ])
    // Without a gateway nothing is added.
    expect(JSON.parse(wslLocalPolicy(LOCKED, { mode: "nat" })!).endpoints).toEqual([
      "https://llm.corp.example.com",
      "http://127.0.0.1:11434",
    ])
  })
})
