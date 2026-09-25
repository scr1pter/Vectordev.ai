;(function () {
  function read(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }

  // Keep this synchronous migration aligned with the theme provider before first paint.
  ;["theme-id", "color-scheme", "theme-css-light", "theme-css-dark"].forEach(function (suffix) {
    var key = "vector-" + suffix
    try {
      if (localStorage.getItem(key) !== null) return
      var candidates = Array.from({ length: localStorage.length }, function (_, index) {
        return localStorage.key(index)
      }).filter(function (candidate) {
        return candidate !== null && candidate !== key && candidate.endsWith("-" + suffix)
      })
      if (candidates.length !== 1) return
      var value = localStorage.getItem(candidates[0])
      if (value === null) return
      localStorage.setItem(key, value)
      localStorage.removeItem(candidates[0])
    } catch {}
  })

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
