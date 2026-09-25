import { render } from "solid-js/web"
import { I18nProvider } from "@vectordevai/ui/context"
import { PlatformProvider } from "../../src/context/platform"
import { LanguageProvider, useLanguage } from "../../src/context/language"
import { ErrorPage } from "../../src/pages/error"
import { initializeSupportReport } from "../../../web/src/components/support/report"
import { yieldLaunchScreen } from "../../src/features/launch/launch-bridge"
import "../../src/index.css"

yieldLaunchScreen("error")

const root = document.querySelector("#root")
const mode = new URL(location.href).searchParams.get("mode")
if (mode === "form") {
  root.innerHTML =
    '<form><label>Your report<textarea name="message" maxlength="8000" required></textarea></label><label>Email<input name="email" type="email" /></label><p id="report-status" role="status"></p><button type="submit">Send report</button></form>'
  initializeSupportReport(root.querySelector("form"))
}
if (mode !== "form") {
  // Test-only Electron bridge: requests terminate at the intercepted local fixture route.
  Object.defineProperty(window, "api", {
    value: {
      reportBug: async (input) => {
        const response = await fetch("/api/support/bug-report", {
          method: "POST",
          body: JSON.stringify(input),
          headers: { "Content-Type": "application/json" },
        })
        if (!response.ok) throw new Error("Synthetic IPC failure")
        return { delivered: true }
      },
    },
  })
  const Crash = () => {
    const language = useLanguage()
    return (
      <I18nProvider value={{ locale: language.intl, t: language.t }}>
        <ErrorPage error={new Error("Synthetic renderer crash for support acceptance")} />
      </I18nProvider>
    )
  }
  render(
    () => (
      <PlatformProvider
        value={{
          platform: mode === "web" ? "web" : "desktop",
          version: "0.0.0-support-fixture",
          openLink: (url) => {
            window.open(url, "_blank")
          },
          restart: async () => {},
          openDirectoryPickerDialog: async () => null,
          back: () => {},
          forward: () => {},
          notify: async () => {},
        }}
      >
        <LanguageProvider locale="en">
          <Crash />
        </LanguageProvider>
      </PlatformProvider>
    ),
    root,
  )
}
