"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type {ComponentProps, ReactNode} from "react";

import {cn} from "./utils";

export const TooltipProvider = TooltipPrimitive.Provider;

export interface TooltipProps {
  children: ReactNode;
  content: ReactNode;
  side?: ComponentProps<typeof TooltipPrimitive.Content>["side"];
}

export function Tooltip({children, content, side = "top"}: TooltipProps) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          className={cn(
            "z-50 max-w-72 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg",
            "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out motion-reduce:animate-none",
          )}
          side={side}
          sideOffset={6}
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-popover" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
