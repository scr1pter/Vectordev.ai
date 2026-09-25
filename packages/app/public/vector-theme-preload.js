;(function () {
  function read(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }

  // Keep this synchronous migration aligned with the theme provider before first paint.
  function migratePreferences() {
    try {
      if (localStorage.getItem("vector-theme-migration") !== null) return
      var candidates = Array.from({ length: localStorage.length }, function (_, index) {
        return localStorage.key(index)
      }).filter(function (key) {
        return key !== null && key !== "vector-theme-id" && key.endsWith("-theme-id")
      })
      if (candidates.length !== 1) return
      var previous = localStorage.getItem(candidates[0])
      var current = localStorage.getItem("vector-theme-id")
      if (!previous || (current !== null && current !== previous)) return
      var prefix = candidates[0].slice(0, -"-theme-id".length)
      ;["theme-id", "color-scheme", "theme-css-light", "theme-css-dark"].forEach(function (suffix) {
        var key = "vector-" + suffix
        if (localStorage.getItem(key) !== null) return
        var value = localStorage.getItem(prefix + "-" + suffix)
        if (value === null) return
        if (suffix === "color-scheme" && !["dark", "light", "system"].includes(value)) return
        localStorage.setItem(key, value)
      })
      localStorage.setItem("vector-theme-migration", "1")
      console.info("Vector restored your earlier theme preferences. Original preferences were kept.")
    } catch {}
  }
  migratePreferences()

  var key = "vector-theme-id"
  var themeId = read(key) || "vector-modern"
  if (themeId === "oc-1" || themeId === "oc-2") {
    themeId = "vector-modern"
    try {
      localStorage.setItem(key, themeId)
    } catch {}
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

  if (themeId === "vector-modern") return

  var css = read("vector-theme-css-" + mode)
  if (css) {
    var style = document.createElement("style")
    style.id = "vector-theme-preload"
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
