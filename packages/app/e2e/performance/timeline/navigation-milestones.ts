import type { Page } from "@playwright/test"

export type NavigationMilestoneSample = {
  observedAtMs: number
  milestones: Record<string, boolean>
}

export function summarizeNavigationMilestones(samples: NavigationMilestoneSample[]) {
  const names = Object.keys(samples[0]?.milestones ?? {})
  const summarize = (matches: (sample: NavigationMilestoneSample) => boolean) => {
    const first = samples.find(matches)
    const stable = samples.findIndex(
      (sample, index) =>
        index + 2 < samples.length && matches(sample) && matches(samples[index + 1]!) && matches(samples[index + 2]!),
    )
    return {
      firstObservedMs: first?.observedAtMs ?? null,
      stableObservedMs: stable === -1 ? null : samples[stable + 2]!.observedAtMs,
    }
  }
  return {
    samples: samples.length,
    milestones: Object.fromEntries(
      names.map((name) => [name, summarize((sample) => sample.milestones[name] === true)]),
    ),
    all: summarize((sample) => names.every((name) => sample.milestones[name] === true)),
  }
}

type NavigationMilestoneProbe = {
  samples: NavigationMilestoneSample[]
  stop: () => void
}

export async function measureNavigationMilestones(
  page: Page,
  input: {
    trigger: { type: "click"; selector: string } | { type: "keydown"; key: string; modifier: "Meta" | "Control" }
    milestones: Record<string, { selector: string; visible?: boolean }>
    navigate: () => Promise<void>
  },
) {
  await page.evaluate(
    ({ trigger, milestones }) => {
      const samples: NavigationMilestoneSample[] = []
      const streaks = new Map<string, number>()
      const marked = new Set<string>()
      let started: number | undefined
      let running = true
      const visible = (selector: string) =>
        [...document.querySelectorAll<HTMLElement>(selector)].some((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
        })
      const sample = () => {
        if (!running || started === undefined) return
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (!running || started === undefined) return
            const current = Object.fromEntries(
              Object.entries(milestones).map(([name, milestone]) => [
                name,
                milestone.visible === false ? !document.querySelector(milestone.selector) : visible(milestone.selector),
              ]),
            )
            samples.push({
              observedAtMs: performance.now() - started,
              milestones: current,
            })
            Object.entries(current).forEach(([name, value]) => {
              if (!value) {
                streaks.set(name, 0)
                return
              }
              if (!marked.has(`${name}.first`)) {
                performance.mark(`opencode.navigation.${name}.first`)
                marked.add(`${name}.first`)
              }
              const streak = (streaks.get(name) ?? 0) + 1
              streaks.set(name, streak)
              if (streak === 3) performance.mark(`opencode.navigation.${name}.stable`)
            })
            const all = Object.values(current).every(Boolean)
            const allStreak = all ? (streaks.get("all") ?? 0) + 1 : 0
            streaks.set("all", allStreak)
            if (all && !marked.has("all.first")) {
              performance.mark("opencode.navigation.all.first")
              marked.add("all.first")
            }
            if (allStreak === 3) performance.mark("opencode.navigation.all.stable")
            sample()
          }, 0)
        })
      }
      const start = () => {
        if (started !== undefined) return
        started = performance.now()
        performance.mark(`opencode.navigation.${trigger.type}`)
        sample()
      }
      const onClick = (event: MouseEvent) => {
        if (trigger.type !== "click" || !(event.target instanceof Element)) return
        if (event.target.closest(trigger.selector)) start()
      }
      const onKeydown = (event: KeyboardEvent) => {
        if (trigger.type !== "keydown" || event.key.toLowerCase() !== trigger.key.toLowerCase()) return
        if (trigger.modifier === "Meta" ? event.metaKey : event.ctrlKey) start()
      }
      if (trigger.type === "click") document.addEventListener("click", onClick, { capture: true })
      if (trigger.type === "keydown") document.addEventListener("keydown", onKeydown, { capture: true })
      ;(window as Window & { __navigationMilestones?: NavigationMilestoneProbe }).__navigationMilestones = {
        samples,
        stop: () => {
          running = false
          document.removeEventListener("click", onClick, { capture: true })
          document.removeEventListener("keydown", onKeydown, { capture: true })
        },
      }
    },
    { trigger: input.trigger, milestones: input.milestones },
  )
  await input.navigate()
  await page.waitForFunction(() => {
    const samples = (window as Window & { __navigationMilestones?: NavigationMilestoneProbe }).__navigationMilestones
      ?.samples
    if (!samples || samples.length < 3) return false
    return samples.slice(-3).every((sample) => Object.values(sample.milestones).every(Boolean))
  })
  const samples = await page.evaluate(() => {
    const probe = (window as Window & { __navigationMilestones?: NavigationMilestoneProbe }).__navigationMilestones!
    probe.stop()
    return probe.samples
  })
  return { summary: summarizeNavigationMilestones(samples), samples }
}
