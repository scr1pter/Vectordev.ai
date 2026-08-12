/** @jsxImportSource react */
import { forwardRef, type ButtonHTMLAttributes } from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

const buttonVariants = cva(
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-[7px] border px-3 text-[10px] font-medium transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a77cff]/55 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary:
          "border-[#d8c7ff]/35 bg-[#b999ff] text-[#100d15] shadow-[0_10px_28px_rgba(117,71,213,0.22)] hover:bg-[#c9b3ff]",
        secondary: "border-white/10 bg-white/[0.045] text-[#d8d2dd] hover:border-[#c8a8ff]/25 hover:bg-white/[0.075]",
        icon: "size-9 min-h-0 border-white/10 bg-white/[0.035] p-0 text-[#918a97] hover:bg-white/[0.07] hover:text-white",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
)

function cn(...values: ClassValue[]) {
  return twMerge(clsx(values))
}

type PlatformButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>

export const PlatformButton = forwardRef<HTMLButtonElement, PlatformButtonProps>(
  ({ className, variant, type = "button", ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant }), className)} {...props} />
  ),
)

PlatformButton.displayName = "PlatformButton"
