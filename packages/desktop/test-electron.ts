import { mock } from "bun:test"
import { tmpdir } from "node:os"

// Outside Electron, "electron" resolves to its binary's path, not the API. A test that imports a module reaching
// electron without mocking it would load that real module, and Bun then cannot link a later test file's named
// imports to that file's own mock, in whatever order the run puts them. This stand-in loads first; test files that
// need particular behaviour mock electron again with their own.
const electron = {
  app: { getPath: () => tmpdir(), isPackaged: false },
  shell: { openExternal: async () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}
mock.module("electron", () => ({ default: electron, ...electron }))
