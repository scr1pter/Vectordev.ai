import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import type { WslServersController } from "./servers"
import { requireWslDistro, requireWslDistros, requireWslServerId } from "./policy"
import type { WslServersState } from "../../preload/types"
import { assertTrustedRenderer } from "../ipc-security"

function handle<T extends unknown[], R>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: T) => R) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRenderer(event)
    return listener(event, ...(args as T))
  })
}

export function registerWslIpcHandlers(controller: WslServersController) {
  if (process.platform !== "win32") {
    registerUnavailableWslIpcHandlers()
    return
  }

  const subscriptions = new Map<number, () => void>()
  const unsubscribe = (id: number) => {
    const off = subscriptions.get(id)
    if (!off) return
    off()
    subscriptions.delete(id)
  }

  app.once("will-quit", () => {
    subscriptions.forEach((off) => off())
    subscriptions.clear()
  })

  handle("wsl-servers-subscribe", (event) => {
    const id = event.sender.id
    if (subscriptions.has(id)) return
    subscriptions.set(
      id,
      controller.subscribe((payload) => {
        if (event.sender.isDestroyed()) {
          unsubscribe(id)
          return
        }
        event.sender.send("wsl-servers-event", payload)
      }),
    )
    event.sender.once("destroyed", () => unsubscribe(id))
  })
  handle("wsl-servers-unsubscribe", (event) => unsubscribe(event.sender.id))
  handle("wsl-servers-get-state", () => controller.getState())
  handle("wsl-servers-probe-runtime", () => controller.probeRuntime())
  handle("wsl-servers-refresh-distros", () => controller.refreshDistros())
  handle("wsl-servers-install-wsl", () => controller.installWsl())
  handle("wsl-servers-install-distro", (_event: IpcMainInvokeEvent, name: string) =>
    controller.installDistro(
      requireWslDistro(
        name,
        controller.getState().online.map((item) => item.name),
      ),
    ),
  )
  handle("wsl-servers-probe-addable", (_event: IpcMainInvokeEvent, distros: string[]) =>
    controller.probeAddable(
      requireWslDistros(
        distros,
        controller.getState().installed.map((item) => item.name),
      ),
    ),
  )
  const installVector = (_event: IpcMainInvokeEvent, name: string) =>
    controller.installVector(
      requireWslDistro(
        name,
        controller.getState().installed.map((item) => item.name),
      ),
    )
  handle("wsl-servers-install-vector", installVector)
  handle("wsl-servers-open-terminal", (_event: IpcMainInvokeEvent, name: string) =>
    controller.openTerminal(
      requireWslDistro(
        name,
        controller.getState().installed.map((item) => item.name),
      ),
    ),
  )
  handle("wsl-servers-add", (_event: IpcMainInvokeEvent, distro: string) =>
    controller.addServer(
      requireWslDistro(
        distro,
        controller.getState().installed.map((item) => item.name),
      ),
    ),
  )
  handle("wsl-servers-remove", (_event: IpcMainInvokeEvent, id: string) =>
    controller.removeServer(
      requireWslServerId(
        id,
        controller.getState().servers.map((item) => item.config.id),
      ),
    ),
  )
  handle("wsl-servers-start", (_event: IpcMainInvokeEvent, id: string) =>
    controller.startServer(
      requireWslServerId(
        id,
        controller.getState().servers.map((item) => item.config.id),
      ),
    ),
  )
}

function registerUnavailableWslIpcHandlers() {
  const unavailable = () => {
    throw new Error("WSL is only available on Windows")
  }
  const state = (): WslServersState => ({
    runtime: {
      available: false,
      version: null,
      error: "WSL is only available on Windows",
    },
    installed: [],
    online: [],
    distroProbes: {},
    vectorChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
  })

  handle("wsl-servers-subscribe", (event) => {
    event.sender.send("wsl-servers-event", { type: "state", state: state() })
  })
  handle("wsl-servers-unsubscribe", () => undefined)
  handle("wsl-servers-get-state", () => state())
  handle("wsl-servers-probe-runtime", unavailable)
  handle("wsl-servers-refresh-distros", unavailable)
  handle("wsl-servers-install-wsl", unavailable)
  handle("wsl-servers-install-distro", unavailable)
  handle("wsl-servers-probe-addable", unavailable)
  handle("wsl-servers-install-vector", unavailable)
  handle("wsl-servers-open-terminal", unavailable)
  handle("wsl-servers-add", unavailable)
  handle("wsl-servers-remove", unavailable)
  handle("wsl-servers-start", unavailable)
}
