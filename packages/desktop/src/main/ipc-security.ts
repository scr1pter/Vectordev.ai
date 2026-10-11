import { BrowserWindow } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { isTrustedRendererUrl } from "./windows"
import { isTrustedRendererEvent } from "./trusted-renderer"

type RendererEvent = IpcMainEvent | IpcMainInvokeEvent

export function assertTrustedRenderer(event: RendererEvent) {
  if (event.sender.isDestroyed()) throw new Error("The requesting Vector window is closed.")
  if (
    !isTrustedRendererEvent(event, {
      windowFor: (contents) => BrowserWindow.fromWebContents(contents),
      trustedUrl: isTrustedRendererUrl,
    })
  )
    throw new Error("Vector rejected a desktop command from an untrusted page.")
}
