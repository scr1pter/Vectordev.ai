import { expect, test } from "bun:test"
import { leakedXdgHomes } from "./xdg-env"

const appId = "ai.vector.app"
const userData = `/home/user/.config/${appId}`

test("finds the XDG values 1.99.99 leaked into a relaunch and the appData they hid", () => {
  expect(
    leakedXdgHomes(
      {
        XDG_DATA_HOME: `${userData}/xdg-data`,
        XDG_CONFIG_HOME: `${userData}/xdg-config`,
        XDG_CACHE_HOME: `${userData}/xdg-cache`,
        XDG_STATE_HOME: `${userData}/xdg-state`,
      },
      appId,
    ),
  ).toEqual({
    keys: ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"],
    appData: "/home/user/.config",
  })
})

test("keeps XDG values the user set", () => {
  expect(
    leakedXdgHomes(
      {
        XDG_CONFIG_HOME: "/home/user/dotfiles/config",
        XDG_DATA_HOME: "/home/user/.local/share",
        XDG_CACHE_HOME: `/home/user/.config/ai.vector.app.beta/xdg-cache`,
      },
      appId,
    ),
  ).toEqual({ keys: [], appData: undefined })
})
