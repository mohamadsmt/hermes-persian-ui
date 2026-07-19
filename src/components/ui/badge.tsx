import {cva, type VariantProps} from "class-variance-authority";
import type {HTMLAttributes} from "react";

import {cn} from "./utils";

const badgeVariants = cva(
  "inline-flex min-h-5 items-center gap-1 rounded-md border px-2 py-0.5 text-[0.6875rem] font-medium",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        accent: "border-primary/20 bg-primary/10 text-primary",
        success: "border-success/25 bg-success/10 text-success",
        warning: "border-warning/25 bg-warning/10 text-warning-foreground",
        danger: "border-destructive/25 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: {tone: "neutral"},
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({className, tone, ...props}: BadgeProps) {
  return <span className={cn(badgeVariants({tone}), className)} {...props} />;
}
