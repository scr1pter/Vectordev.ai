;(function () {
  var migrated = false
  function read(key) {
    var current = localStorage.getItem(key)
    if (current !== null) return current
    var legacy = localStorage.getItem(key.replace(/^vector-/, "opencode-"))
    if (legacy !== null) {
      localStorage.setItem(key, legacy)
      if (!migrated) console.warn("[Vector] Migrated legacy theme preferences.")
      migrated = true
    }
    return legacy
  }

  var key = "vector-theme-id"
  var themeId = read(key) || "oc-2"

  if (themeId === "oc-1") {
    themeId = "oc-2"
    localStorage.setItem(key, themeId)
    localStorage.removeItem("vector-theme-css-light")
    localStorage.removeItem("vector-theme-css-dark")
    localStorage.removeItem("opencode-theme-css-light")
    localStorage.removeItem("opencode-theme-css-dark")
  }

  var scheme = read("vector-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = isDark ? "#080808" : "#fafafa"

  // Update theme-color meta tag to match app color scheme
  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", isDark ? "#080808" : "#fafafa")

  if (themeId === "oc-2") return

  var css = read("vector-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "oc-theme-preload"
    style.textContent =
      ":root{color-scheme:" +
      mode +
      ";--text-mix-blend-mode:" +
      (isDark ? "plus-lighter" : "multiply") +
      ";" +
      css +
      "}"
    document.head.appendChild(style)
  }
})()
