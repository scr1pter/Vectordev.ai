import React, { useState } from "react"
import { ArrowDownToLine, BookOpen, History, Menu, Sparkles, X } from "lucide-react"
import { Drawer } from "vaul"
import { Button } from "./ui/button"

type ActivePage = "product" | "docs" | "releases" | "download"

const links = [
  { label: "Product", href: "/", icon: Sparkles, id: "product" as const },
  { label: "Documentation", href: "/docs", icon: BookOpen, id: "docs" as const },
  { label: "Releases", href: "/releases", icon: History, id: "releases" as const },
  { label: "Download Vector", href: "/download", icon: ArrowDownToLine, id: "download" as const },
]

export function MarketingMobileNav({ active }: { active: ActivePage }) {
  const [open, setOpen] = useState(false)

  return (
    <Drawer.Root open={open} onOpenChange={setOpen} direction="right">
      <Drawer.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open navigation" className="border border-white/10 bg-black/20">
          <Menu className="size-[18px]" aria-hidden="true" />
        </Button>
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm" />
        <Drawer.Content className="fixed inset-y-0 right-0 z-[100] flex w-[min(88vw,360px)] flex-col border-l border-white/10 bg-[#0b0a0e] p-5 text-white shadow-[-24px_0_80px_rgba(0,0,0,.55)] outline-none">
          <div className="flex items-center justify-between border-b border-white/8 pb-4">
            <Drawer.Title className="text-sm font-semibold">Navigate Vector</Drawer.Title>
            <Drawer.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close navigation">
                <X className="size-[18px]" aria-hidden="true" />
              </Button>
            </Drawer.Close>
          </div>
          <Drawer.Description className="mt-4 text-sm leading-6 text-zinc-500">
            Product details, practical documentation, and installers for every supported desktop platform.
          </Drawer.Description>
          <nav className="mt-8 grid gap-2" aria-label="Mobile navigation">
            {links.map((link) => {
              const Icon = link.icon
              const selected = active === link.id
              return (
                <a
                  key={link.id}
                  href={link.href}
                  aria-current={selected ? "page" : undefined}
                  className={`flex h-12 items-center gap-3 rounded-md border px-3 text-sm font-medium transition-colors ${
                    selected
                      ? "border-vector-400/30 bg-vector-500/12 text-white"
                      : "border-transparent text-zinc-400 hover:border-white/10 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  <Icon className="size-[18px] text-vector-300" aria-hidden="true" />
                  {link.label}
                </a>
              )
            })}
          </nav>
          <div className="mt-auto border-t border-white/8 pt-5 text-xs leading-5 text-zinc-600">
            Vector is a local-first AI engineering workspace for building, testing, reviewing, and shipping software.
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
