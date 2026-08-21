import { spawn, type ChildProcess } from "node:child_process"
import { untrustedChildEnvironment } from "@opencode-ai/core/child-environment"

export type VoiceSpeechResult = {
  status: "spoken" | "unavailable" | "stopped" | "failed"
  message?: string
}

type SpeechCandidate = {
  command: string
  args: string[]
  stdin?: string
}

const active = new Map<number, ChildProcess>()
const stopped = new WeakSet<ChildProcess>()

function candidates(text: string): SpeechCandidate[] {
  if (process.platform === "darwin") {
    return [{ command: "/usr/bin/say", args: ["-r", "185"], stdin: text }]
  }
  if (process.platform === "win32") {
    const script = [
      "$text = [Console]::In.ReadToEnd()",
      "Add-Type -AssemblyName System.Speech",
      "$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "try { $speaker.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female) } catch {}",
      "$speaker.Rate = 1",
      "$speaker.Speak($text)",
    ].join("; ")
    return [{ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script], stdin: text }]
  }
  if (process.platform === "linux") {
    return [
      { command: "spd-say", args: ["--wait", "--", text] },
      { command: "espeak-ng", args: ["-s", "180", "--stdin"], stdin: text },
      { command: "espeak", args: ["-s", "180", "--stdin"], stdin: text },
    ]
  }
  return []
}

export function stopVoiceSynthesis(ownerID: number) {
  const child = active.get(ownerID)
  if (!child) return
  stopped.add(child)
  active.delete(ownerID)
  child.kill()
}

export async function speakVoiceText(ownerID: number, input: string): Promise<VoiceSpeechResult> {
  const text = input.replace(/\s+/g, " ").trim().slice(0, 4_000)
  if (!text) return { status: "failed", message: "Nothing to speak." }
  stopVoiceSynthesis(ownerID)
  const options = candidates(text)
  if (!options.length) return { status: "unavailable" }

  const attempt = (index: number): Promise<VoiceSpeechResult> => {
    const option = options[index]
    if (!option) return Promise.resolve({ status: "unavailable" })

    return new Promise((resolve) => {
      const child = spawn(option.command, option.args, {
        env: untrustedChildEnvironment(),
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      })
      active.set(ownerID, child)
      let settled = false

      const finish = (result: VoiceSpeechResult) => {
        if (settled) return
        settled = true
        if (active.get(ownerID) === child) active.delete(ownerID)
        resolve(result)
      }

      const tryNext = () => {
        if (settled) return
        settled = true
        if (active.get(ownerID) === child) active.delete(ownerID)
        void attempt(index + 1).then(resolve)
      }

      child.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          tryNext()
          return
        }
        finish({ status: "failed", message: error.message })
      })
      child.once("close", (code) => {
        if (stopped.has(child)) {
          finish({ status: "stopped" })
          return
        }
        if (code === 0) {
          finish({ status: "spoken" })
          return
        }
        if (index + 1 < options.length) {
          tryNext()
          return
        }
        finish({ status: "failed", message: `Speech process exited with code ${code ?? "unknown"}.` })
      })

      child.stdin.on("error", () => undefined)
      child.stdin.end(option.stdin ?? undefined)
    })
  }

  return attempt(0)
}
