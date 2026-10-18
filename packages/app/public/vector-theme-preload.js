;(function () {
  // Vector has one look: its own theme, in dark. Settings no longer offers a theme or a colour scheme, so a theme, a
  // Light or Match system scheme, or a theme's cached CSS saved by an earlier version is put back here, before the
  // first frame. The theme provider then starts from the same values, and nothing paints light first.
  try {
    localStorage.setItem("vector-theme-id", "vector-modern")
    localStorage.setItem("vector-color-scheme", "dark")
    localStorage.removeItem("vector-theme-css-light")
    localStorage.removeItem("vector-theme-css-dark")
    // The provider would otherwise copy another app's saved theme in on its first run.
    localStorage.setItem("vector-theme-migration", "1")
  } catch {}

  document.documentElement.dataset.theme = "vector-modern"
  document.documentElement.dataset.colorScheme = "dark"
  document.documentElement.style.backgroundColor = "#080808"

  var metas = document.querySelectorAll("meta[name='theme-color']")
  if (metas.length > 0) metas[0].setAttribute("content", "#080808")
})()
