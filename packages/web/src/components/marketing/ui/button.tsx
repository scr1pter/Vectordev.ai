import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "./cn"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-semibold transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vector-400 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-vector-300 text-zinc-950 hover:bg-white",
        ghost: "text-zinc-300 hover:bg-white/7 hover:text-white",
        outline: "border border-white/12 bg-white/3 text-zinc-200 hover:border-white/20 hover:bg-white/7",
      },
      size: {
        icon: "size-10",
        default: "h-10 px-4",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
)

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
)

Button.displayName = "Button"
