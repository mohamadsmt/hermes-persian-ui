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
      className={cn(
        size === "sm"
          && "size-8 min-h-8 rounded-md max-[42rem]:size-11 max-[42rem]:min-h-11 max-[42rem]:rounded-lg",
        className,
      )}
      size="icon"
      title={label}
      variant={tone === "danger" ? "destructive" : "ghost"}
      {...props}
    >
      {children}
    </Button>
  );
}
