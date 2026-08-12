import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { promisify } from "node:util"
import { app, dialog } from "electron"

import { runBrowserAgent } from "./browser-agent"
import { parseBrowserAgentInput } from "./browser-bridge-input"
import { decryptCloudCredential, encryptCloudCredential } from "./cloud-credential-vault"
import { getStore } from "./store"

const executeFile = promisify(execFile)
const STORE_NAME = "vector.companion"
const CREDENTIAL_KEY = "credential"

type CompanionCredential = { credential: string; apiBase: string; device: { id: string; name: string } }
type CompanionCommand = {
  id: string
  run_id: string
  action: "browser" | "shell"
  payload: Record<string, unknown>
  risk: "low" | "medium" | "high"
}

let stopped = false
let polling: Promise<void> | undefined

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function credentialValue(value: unknown): CompanionCredential | undefined {
  const record = objectValue(value)
  const device = objectValue(record?.device)
  if (
    typeof record?.credential !== "string" ||
    typeof record.apiBase !== "string" ||
    typeof device?.id !== "string" ||
    typeof device.name !== "string"
  ) return undefined
  return { credential: record.credential, apiBase: record.apiBase, device: { id: device.id, name: device.name } }
}

function commandValue(value: unknown): CompanionCommand | undefined {
  const record = objectValue(value)
  const payload = objectValue(record?.payload)
  if (
    typeof record?.id !== "string" ||
    typeof record.run_id !== "string" ||
    (record.action !== "browser" && record.action !== "shell") ||
    (record.risk !== "low" && record.risk !== "medium" && record.risk !== "high") ||
    !payload
  ) return undefined
  return { id: record.id, run_id: record.run_id, action: record.action, payload, risk: record.risk }
}

function savedCredential(): CompanionCredential | undefined {
  const value = getStore(STORE_NAME).get(CREDENTIAL_KEY)
  if (typeof value !== "string") return undefined
  try {
    return credentialValue(JSON.parse(decryptCloudCredential(value)))
  } catch {
    getStore(STORE_NAME).delete(CREDENTIAL_KEY)
    return undefined
  }
}

function saveCredential(value: CompanionCredential) {
  getStore(STORE_NAME).set(CREDENTIAL_KEY, encryptCloudCredential(JSON.stringify(value)))
}

async function pair(url: URL) {
  const token = url.searchParams.get("token")
  if (!token) return
  const approval = await dialog.showMessageBox({
    type: "question",
    title: "Connect Vector Cloud Agents",
    message: "Allow your Vector account to request actions on this computer?",
    detail:
      "Browser and terminal actions are never silent. Vector will show the exact action and ask you to approve it on this computer before it runs.",
    buttons: ["Cancel", "Connect"],
    defaultId: 1,
    cancelId: 0,
    checkboxLabel: "Also allow terminal commands (each command still requires approval)",
    checkboxChecked: false,
    noLink: true,
  })
  if (approval.response !== 1) return
  const apiBase = (process.env.VECTOR_PUBLIC_URL || "https://vectordev.ai").replace(/\/$/, "")
  const response = await fetch(`${apiBase}/api/platform/devices`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "claim",
      token,
      name: `${app.getName()} on ${process.platform}`,
      platform: `${process.platform}-${process.arch}`,
      permissions: approval.checkboxChecked ? ["browser", "shell"] : ["browser"],
    }),
  })
  const payload = objectValue(await response.json().catch(() => undefined)) || {}
  const credential = credentialValue(payload)
  if (!response.ok || !credential) {
    const message = Reflect.get(objectValue(payload.error) || {}, "message")
    throw new Error(typeof message === "string" ? message : "Vector could not pair this computer.")
  }
  saveCredential(credential)
  void startCompanionClient()
  await dialog.showMessageBox({
    type: "info",
    title: "Computer connected",
    message: "Vector Cloud Agents can now request approved actions on this computer.",
    detail: "You can disconnect it at any time from Cloud Agents. Each browser or terminal action still asks first.",
  })
}

export async function handleCompanionDeepLinks(urls: string[]) {
  const remaining: string[] = []
  for (const value of urls) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      remaining.push(value)
      continue
    }
    if (url.protocol !== "vector:" || url.hostname !== "companion" || url.pathname !== "/pair") {
      remaining.push(value)
      continue
    }
    await pair(url).catch(async (error) => {
      await dialog.showMessageBox({
        type: "error",
        title: "Pairing failed",
        message: error instanceof Error ? error.message : "Vector could not pair this computer.",
      })
    })
  }
  return remaining
}

async function approvalFor(command: CompanionCommand) {
  const operation = stringValue(command.payload.operation, "Browser action")
  const url = stringValue(command.payload.url)
  const selector = stringValue(command.payload.selector)
  const summary =
    command.action === "shell"
      ? stringValue(command.payload.command, "Terminal command")
      : `${operation}${url ? `\n${url}` : ""}${selector ? `\n${selector}` : ""}`
  const result = await dialog.showMessageBox({
    type: command.risk === "high" ? "warning" : "question",
    title: "Cloud Agent requests computer access",
    message: command.action === "shell" ? "Allow this terminal command?" : "Allow this browser action?",
    detail: summary.slice(0, 12_000),
    buttons: ["Deny", "Allow once"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return result.response === 1
}

async function execute(command: CompanionCommand) {
  if (command.action === "browser") {
    const input = parseBrowserAgentInput({ ...command.payload, allowExternal: true })
    return runBrowserAgent(undefined, input)
  }
  const text = stringValue(command.payload.command).trim()
  if (!text) throw new Error("The requested terminal command was empty.")
  const cwd = typeof command.payload.cwd === "string" && command.payload.cwd.trim() ? command.payload.cwd : homedir()
  const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/zsh"
  const args = process.platform === "win32" ? ["/d", "/s", "/c", text] : ["-lc", text]
  const result = await executeFile(shell, args, { cwd, timeout: 5 * 60_000, maxBuffer: 2 * 1024 * 1024 })
  return { ok: true, stdout: result.stdout.slice(-500_000), stderr: result.stderr.slice(-500_000), cwd }
}

async function answer(credential: CompanionCredential, command: CompanionCommand) {
  const allowed = await approvalFor(command)
  let body: Record<string, unknown>
  if (!allowed) {
    body = { id: command.id, status: "denied", error: "The user denied this action on their computer." }
  } else {
    try {
      body = { id: command.id, status: "success", result: await execute(command) }
    } catch (error) {
      body = { id: command.id, status: "failed", error: error instanceof Error ? error.message : String(error) }
    }
  }
  await fetch(`${credential.apiBase}/api/platform/device-commands`, {
    method: "POST",
    headers: { authorization: `Device ${credential.credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function poll() {
  for (;;) {
    if (stopped) return
    const credential = savedCredential()
    if (!credential) return
    try {
      const response = await fetch(`${credential.apiBase}/api/platform/device-commands`, {
        headers: { authorization: `Device ${credential.credential}` },
      })
      if (response.status === 401) {
        getStore(STORE_NAME).delete(CREDENTIAL_KEY)
        return
      }
      const payload = objectValue(await response.json().catch(() => undefined))
      const command = commandValue(payload?.command)
      if (command) await answer(credential, command)
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 2_500))
  }
}

export function startCompanionClient() {
  stopped = false
  if (!polling) polling = poll().finally(() => (polling = undefined))
  return polling
}

export function stopCompanionClient() {
  stopped = true
}
