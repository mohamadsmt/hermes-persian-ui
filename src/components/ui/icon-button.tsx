import type {ButtonHTMLAttributes} from "react";

import {Button} from "./button";
import {cn} from "./utils";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "sm" | "md";
  tone?: "default" | "danger";
}

export function IconButton({
  children,
  className,
  label,
  size = "md",
  tone = "default",
  ...props
}: IconButtonProps) {
  return (
    <Button
      aria-label={label}
      className={cn(size === "sm" && "size-9 min-h-9 rounded-lg", className)}
      size="icon"
      title={label}
      variant={tone === "danger" ? "destructive" : "ghost"}
      {...props}
    >
      {children}
    </Button>
  );
}

