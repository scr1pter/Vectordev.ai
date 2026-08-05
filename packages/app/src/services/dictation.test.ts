import { describe, expect, test } from "bun:test"
import { createVoiceTurnDetector } from "./dictation"

describe("voice turn endpointing", () => {
  test("waits through room noise and ends after sustained speech followed by silence", () => {
    const detector = createVoiceTurnDetector({ silenceMs: 900, minimumVoiceMs: 120, minimumSpeechMs: 260 })

    expect(detector.sample(0.004, 0)).toBe("waiting")
    expect(detector.sample(0.005, 100)).toBe("waiting")
    expect(detector.sample(0.03, 200)).toBe("waiting")
    expect(detector.sample(0.032, 340)).toBe("speaking")
    expect(detector.sample(0.028, 620)).toBe("speaking")
    expect(detector.sample(0.004, 1_300)).toBe("speaking")
    expect(detector.sample(0.004, 1_600)).toBe("complete")
  })

  test("does not treat a short noise spike as a spoken turn", () => {
    const detector = createVoiceTurnDetector({ silenceMs: 700, minimumVoiceMs: 160 })

    expect(detector.sample(0.04, 0)).toBe("waiting")
    expect(detector.sample(0.003, 90)).toBe("waiting")
    expect(detector.sample(0.003, 1_000)).toBe("waiting")
  })
})
