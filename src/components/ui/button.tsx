import {Slot} from "@radix-ui/react-slot";
import {cva, type VariantProps} from "class-variance-authority";
import type {ButtonHTMLAttributes} from "react";

import {cn} from "./utils";

export const buttonVariants = cva(
  "inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-3 text-sm font-medium transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none max-[42rem]:min-h-11 max-[42rem]:rounded-xl",
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 active:bg-primary/80",
        secondary:
          "border-border bg-surface text-foreground shadow-xs hover:bg-muted active:bg-muted/80",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      },
      size: {
        sm: "min-h-8 rounded-md px-2.5 text-xs max-[42rem]:min-h-11 max-[42rem]:rounded-lg",
        md: "min-h-9 px-3",
        lg: "min-h-10 px-4 text-sm max-[42rem]:min-h-11",
        icon: "size-9 min-h-9 p-0 max-[42rem]:size-11 max-[42rem]:min-h-11",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({
  asChild = false,
  className,
  size,
  type = "button",
  variant,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";

  return (
    <Component
      className={cn(buttonVariants({size, variant}), className)}
      type={asChild ? undefined : type}
      {...props}
    />
  );
}
