// Vector Design Lab: shared behaviour for every page.
// - <i data-icon="name" data-size="16"></i> becomes the app's SVG glyph (window.LAB_ICONS).
// - <nav data-lab-sidebar data-active="mcp"></nav> becomes the app sidebar.
// - .lab-viewport[data-height] scales its 1440px .lab-stage to the window's width.
// - [data-tabs] groups, .seg buttons and .switch toggles work without extra code.
// - <header data-lab-topbar data-slug="..."></header> gets the design's number, title and prev/next links.
// Designs add their own behaviour in a <script> at the end of their page.

;(function () {
  // The site's root, found from this script's own address, so every link works from a
  // folder on disk (file://) as well as on Vercel (where .html links redirect to clean URLs).
  const root = new URL("../", document.currentScript.src).href
  const page = (path) => (path === "" ? `${root}index.html` : `${root}${path}.html`)
  const icons = () => window.LAB_ICONS ?? {}

  function svg(name, size) {
    const glyph = icons()[name]
    if (!glyph) return ""
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${glyph.box} ${glyph.box}" fill="none" aria-hidden="true" focusable="false">${glyph.body}</svg>`
  }

  function renderIcons(root) {
    root.querySelectorAll("i[data-icon]").forEach((el) => {
      const size = Number(el.dataset.size ?? 16)
      const html = svg(el.dataset.icon, size)
      if (!html) return
      el.insertAdjacentHTML("beforebegin", html)
      const made = el.previousElementSibling
      if (made && el.className) made.setAttribute("class", el.className)
      el.remove()
    })
  }

  const NAV = [
    { group: null, items: [
      { id: "home", icon: "home", name: "Home" },
      { id: "search", icon: "search", name: "Search", kbd: "⌘P" },
    ] },
    { group: "Project tools", items: [
      { id: "dashboard", icon: "dashboard", name: "Agent Dashboard" },
      { id: "browser", icon: "browser", name: "Browser" },
    ] },
    { group: "Connections", items: [
      { id: "pulls", icon: "pulls", name: "Pull Requests" },
      { id: "mcp", icon: "mcp", name: "MCP" },
      { id: "plugins", icon: "plugins", name: "Plugins" },
    ] },
  ]

  function renderSidebar(nav) {
    const active = nav.dataset.active ?? ""
    const workspace = nav.dataset.workspace ?? "Vector"
    const branch = nav.dataset.branch ?? "main"
    const links = (window.LAB_LINKS ?? {})
    const item = (it) => {
      const href = links[it.id] ? page(links[it.id]) : undefined
      const tag = href ? "a" : "p"
      const cls = `sb-item${it.id === active ? " is-active" : ""}`
      return `<${tag} class="${cls}"${href ? ` href="${href}"` : ""}>${svg(it.icon, 13)}<span>${it.name}</span>${it.kbd ? `<kbd>${it.kbd}</kbd>` : ""}</${tag}>`
    }
    const groups = NAV.map((g, i) =>
      i === 0
        ? `<div class="sb-primary">${g.items.map(item).join("")}</div>`
        : `<div class="sb-group"><p class="sb-label">${g.group}</p>${g.items.map(item).join("")}</div>`,
    ).join("")
    nav.outerHTML = `<aside class="sb" aria-label="Vector sidebar">
      <div class="sb-top"><div class="sb-mode" aria-hidden="true"><span class="is-on">Agent</span><span>Editor</span></div><span class="sb-icon-btn">${svg("sidebar-hide", 15)}</span></div>
      ${groups.replace("</div>", `</div><div class="sb-projects"><p class="sb-label" style="padding-left:4px">Projects</p><p class="sb-project">${svg("caret", 13)}<span class="sb-project-mark">${svg("project", 11)}</span><span style="flex:1">Vectordev.ai</span><span class="muted" style="font-size:11px">3</span></p><div class="sb-row${active === "workspace" ? " is-active" : ""}"><span class="muted">${svg("branch", 15)}</span><span class="sb-row-text"><span class="sb-row-name">${workspace}</span><span class="sb-row-sub">${branch} · Ready</span></span></div></div>`)}
      <div class="sb-foot"><span>Vector workspace</span><span class="sb-icon-btn">${svg("help", 13)}</span><a class="sb-icon-btn${active === "settings" ? " is-active" : ""}" ${links.settings ? `href="${page(links.settings)}"` : ""} style="${active === "settings" ? "color:var(--violet-bright)" : ""}">${svg("settings", 13)}</a></div>
    </aside>`
  }

  function fit() {
    document.querySelectorAll(".lab-viewport").forEach((viewport) => {
      const stage = viewport.querySelector(".lab-stage")
      if (!stage) return
      const height = Number(viewport.dataset.height ?? 900)
      const scale = viewport.clientWidth / 1440
      stage.style.height = `${height}px`
      stage.style.transform = `scale(${scale})`
      viewport.style.height = `${height * scale}px`
    })
  }

  function wire(root) {
    // Tabs: <div data-tabs="name"> with .tab[data-tab=x]; panels [data-panel=x][data-tabs-for=name]
    root.querySelectorAll("[data-tabs]").forEach((group) => {
      const name = group.dataset.tabs
      group.addEventListener("click", (event) => {
        const tab = event.target.closest("[data-tab]")
        if (!tab || !group.contains(tab)) return
        group.querySelectorAll("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)))
        root.querySelectorAll(`[data-tabs-for="${name}"]`).forEach((panel) => {
          panel.hidden = panel.dataset.panel !== tab.dataset.tab
        })
      })
    })
    root.addEventListener("click", (event) => {
      const seg = event.target.closest(".seg button")
      if (seg) {
        seg.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === seg)))
        seg.parentElement.dispatchEvent(new CustomEvent("lab:seg", { detail: seg.dataset.value ?? seg.textContent.trim(), bubbles: true }))
      }
      const sw = event.target.closest(".switch")
      if (sw) {
        const on = sw.getAttribute("aria-checked") !== "true"
        sw.setAttribute("aria-checked", String(on))
        sw.dispatchEvent(new CustomEvent("lab:switch", { detail: on, bubbles: true }))
      }
    })
  }

  function topbar() {
    const bar = document.querySelector("[data-lab-topbar]")
    if (!bar) return
    const list = (window.LAB_DESIGNS ?? []).toSorted((a, b) => a.number - b.number)
    const index = list.findIndex((d) => d.slug === bar.dataset.slug)
    const design = list[index]
    if (!design) return
    const num = `D${String(design.number).padStart(2, "0")}`
    document.title = `${num} ${design.title} · Vector Design Lab`
    const prev = list[index - 1]
    const next = list[index + 1]
    bar.className = "lab-topbar"
    bar.innerHTML = `<a href="${page("")}">← All designs</a><span class="lab-num">${num}</span><h1>${design.title}</h1><span class="badge">${design.area}</span><span class="lab-spacer"></span><span class="lab-pager">${prev ? `<a class="btn btn-sm" href="${page(`designs/${prev.slug}`)}">← D${String(prev.number).padStart(2, "0")}</a>` : ""}${next ? `<a class="btn btn-sm" href="${page(`designs/${next.slug}`)}">D${String(next.number).padStart(2, "0")} →</a>` : ""}</span>`
    const note = document.querySelector("[data-lab-note]")
    if (note) note.innerHTML = `<strong>The idea:</strong> ${design.idea}`
    const title = document.querySelector(".lab-bar-title")
    if (title) title.textContent = `Vector — ${design.title}`
  }

  window.LabUI = { svg, renderIcons, fit, wire, page }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("nav[data-lab-sidebar]").forEach(renderSidebar)
    renderIcons(document)
    wire(document)
    topbar()
    fit()
    new ResizeObserver(fit).observe(document.documentElement)
  })
})()
