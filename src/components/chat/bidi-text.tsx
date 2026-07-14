import {
  Children,
  createElement,
  isValidElement,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import {cn} from "@/components/ui/utils";

/**
 * A run of ASCII technical text. Spaces are included only while the next
 * character is also ASCII, which keeps a command or English error intact as a
 * single LTR island without consuming surrounding Persian prose.
 */
const TECHNICAL_RUN_PATTERN =
  /(?:[A-Za-z0-9$#]|[/\\](?=[A-Za-z0-9])|\.\.?[/\\](?=[A-Za-z0-9]))(?:[A-Za-z0-9$%#@+.,:;_~?=/\\()[\]{}-]|[ \t]+(?=[A-Za-z0-9$#/\\.]))*/g;

function isolateText(text: string): ReactNode {
  const matches = [...text.matchAll(TECHNICAL_RUN_PATTERN)];

  if (matches.length === 0) {
    return text;
  }

  const result: ReactNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    const index = match.index;
    const technicalText = match[0].replace(/[.,;!?]+$/u, "");
    const trailingPunctuation = match[0].slice(technicalText.length);

    if (index > cursor) {
      result.push(text.slice(cursor, index));
    }

    if (technicalText) {
      result.push(
        <bdi className="technical-inline" dir="ltr" key={`technical-${index}`}>
          {technicalText}
        </bdi>,
      );
    }
    if (trailingPunctuation) {
      result.push(trailingPunctuation);
    }
    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    result.push(text.slice(cursor));
  }

  return result;
}

/**
 * Isolates only visual React output. It never inserts directional control
 * characters and never mutates the source string used by message copy.
 */
export function isolateInlineContent(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return isolateText(child);
    }

    if (typeof child === "number") {
      return (
        <bdi className="technical-inline" dir="ltr">
          {child}
        </bdi>
      );
    }

    return child;
  });
}

export interface BidiBlockProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  "data-testid"?: string;
  isolateInline?: boolean;
}

export function BidiBlock({
  as: Component = "div",
  children,
  className,
  "data-testid": testId = "bidi-block",
  dir = "auto",
  isolateInline = true,
  ...props
}: BidiBlockProps) {
  return createElement(
    Component,
    {
      ...props,
      className: cn("bidi-block", className),
      "data-testid": testId,
      dir,
    },
    isolateInline ? isolateInlineContent(children) : children,
  );
}

export interface BidiInlineProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
}

export function BidiInline({children, className, dir = "auto", ...props}: BidiInlineProps) {
  return (
    <bdi className={cn("bidi-inline", className)} dir={dir} {...props}>
      {isolateInlineContent(children)}
    </bdi>
  );
}

export function TechnicalInline({children, className, ...props}: BidiInlineProps) {
  return (
    <bdi className={cn("technical-inline", className)} dir="ltr" {...props}>
      {children}
    </bdi>
  );
}

export function getLogicalText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(getLogicalText).join("");
  }

  if (isValidElement<{children?: ReactNode}>(node)) {
    return getLogicalText(node.props.children);
  }

  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }

  return "";
}
