"use client";

import {code} from "@streamdown/code";
import {Check, Copy, WrapText} from "lucide-react";
import {useTranslations} from "next-intl";
import {
  CodeBlock,
  Streamdown,
  useIsCodeFenceIncomplete,
  type Components,
} from "streamdown";
import type {
  AnchorHTMLAttributes,
  ComponentPropsWithoutRef,
} from "react";
import {useEffect, useState} from "react";

import {IconButton} from "@/components/ui/icon-button";
import {cn} from "@/components/ui/utils";

import {
  BidiBlock,
  BidiInline,
  TechnicalInline,
  getLogicalText,
  isolateInlineContent,
} from "./bidi-text";

async function writeClipboardText(source: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(source);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = source;
  textarea.readOnly = true;
  textarea.style.position = "fixed";
  textarea.style.inset = "-9999px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Clipboard API is unavailable");
  }
}

interface ClipboardButtonProps {
  className?: string;
  label: string;
  source: string;
  testId?: string;
}

function ClipboardButton({className, label, source, testId}: ClipboardButtonProps) {
  const translations = useTranslations("Markdown");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeout = window.setTimeout(() => setCopied(false), 1_800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  return (
    <IconButton
      className={className}
      data-testid={testId}
      label={copied ? translations("copied") : label}
      onClick={async () => {
        try {
          await writeClipboardText(source);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
      size="sm"
    >
      {copied ? (
        <Check aria-hidden="true" className="size-4 text-success" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
    </IconButton>
  );
}

export interface CopyMessageButtonProps {
  className?: string;
  source: string;
}

export function CopyMessageButton({className, source}: CopyMessageButtonProps) {
  const translations = useTranslations("Markdown");

  return (
    <ClipboardButton
      className={className}
      label={translations("copyMessage")}
      source={source}
      testId="copy-message"
    />
  );
}

export interface TechnicalCodeBlockProps {
  className?: string;
  filename?: string;
  isIncomplete?: boolean;
  language?: string;
  source: string;
}

export function TechnicalCodeBlock({
  className,
  filename,
  isIncomplete = false,
  language = "text",
  source,
}: TechnicalCodeBlockProps) {
  const translations = useTranslations("Markdown");
  const [wrap, setWrap] = useState(false);

  return (
    <div
      className={cn("markdown-code-shell", className)}
      data-has-filename={filename ? "true" : undefined}
      data-testid="code-block"
      data-wrap={wrap}
      dir="ltr"
    >
      <CodeBlock
        code={source}
        isIncomplete={isIncomplete}
        language={language || "text"}
        lineNumbers
      >
        <ClipboardButton label={translations("copyCode")} source={source} testId="copy-code" />
        <IconButton
          aria-pressed={wrap}
          label={wrap ? translations("unwrapCode") : translations("wrapCode")}
          onClick={() => setWrap((current) => !current)}
          size="sm"
        >
          <WrapText aria-hidden="true" className="size-4" />
        </IconButton>
      </CodeBlock>
      {filename ? (
        <div className="markdown-code-metadata" dir="ltr">
          <bdi className="markdown-code-language" dir="ltr">{language || "text"}</bdi>
          <span aria-hidden="true">·</span>
          <bdi className="markdown-code-filename" dir="ltr" title={filename}>{filename}</bdi>
        </div>
      ) : null}
    </div>
  );
}

interface MarkdownNodeProps {
  node?: unknown;
}

type MarkdownElementProps<Tag extends keyof React.JSX.IntrinsicElements> =
  ComponentPropsWithoutRef<Tag> & MarkdownNodeProps;

function getMetaString(node: unknown): string | undefined {
  if (!node || typeof node !== "object" || !("properties" in node)) {
    return undefined;
  }

  const properties = node.properties;

  if (!properties || typeof properties !== "object" || !("metastring" in properties)) {
    return undefined;
  }

  return typeof properties.metastring === "string" ? properties.metastring : undefined;
}

function getFilename(meta: string | undefined): string | undefined {
  if (!meta) {
    return undefined;
  }

  return meta.match(/(?:filename|title)=(?:"([^"]+)"|'([^']+)'|([^\s]+))/)?.slice(1).find(Boolean);
}

function MarkdownCode({children, className, node}: MarkdownElementProps<"code">) {
  const isIncomplete = useIsCodeFenceIncomplete();
  const language = className?.match(/language-([^\s]+)/)?.[1] ?? "text";
  const logicalSource = getLogicalText(children);
  // Markdown parsers expose the structural newline before the closing fence as a child.
  // It is not part of the user's logical code payload, so copy removes exactly that one newline.
  const source = logicalSource.endsWith("\n") ? logicalSource.slice(0, -1) : logicalSource;

  return (
    <TechnicalCodeBlock
      filename={getFilename(getMetaString(node))}
      isIncomplete={isIncomplete}
      language={language}
      source={source}
    />
  );
}

function InlineCode({children, className, node: _node, ...props}: MarkdownElementProps<"code">) {
  return (
    <code
      className={cn(
        "technical-content rounded-md bg-muted px-1.5 py-0.5 text-[0.875em] font-medium text-foreground",
        className,
      )}
      dir="ltr"
      {...props}
    >
      <TechnicalInline>{children}</TechnicalInline>
    </code>
  );
}

function SafeLink({
  children,
  className,
  href,
  node: _node,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & MarkdownNodeProps) {
  return (
    <a
      className={cn("break-words underline", className)}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
      {...props}
    >
      <BidiInline>{children}</BidiInline>
    </a>
  );
}

const markdownComponents = {
  p: ({children, node: _node, ...props}: MarkdownElementProps<"p">) => (
    <BidiBlock as="p" {...props}>
      {children}
    </BidiBlock>
  ),
  h1: ({children, node: _node, ...props}: MarkdownElementProps<"h1">) => (
    <BidiBlock as="h1" className="mt-7 text-2xl font-semibold" {...props}>
      {children}
    </BidiBlock>
  ),
  h2: ({children, node: _node, ...props}: MarkdownElementProps<"h2">) => (
    <BidiBlock as="h2" className="mt-6 text-xl font-semibold" {...props}>
      {children}
    </BidiBlock>
  ),
  h3: ({children, node: _node, ...props}: MarkdownElementProps<"h3">) => (
    <BidiBlock as="h3" className="mt-5 text-lg font-semibold" {...props}>
      {children}
    </BidiBlock>
  ),
  h4: ({children, node: _node, ...props}: MarkdownElementProps<"h4">) => (
    <BidiBlock as="h4" className="mt-5 font-semibold" {...props}>
      {children}
    </BidiBlock>
  ),
  h5: ({children, node: _node, ...props}: MarkdownElementProps<"h5">) => (
    <BidiBlock as="h5" className="mt-4 text-sm font-semibold" {...props}>
      {children}
    </BidiBlock>
  ),
  h6: ({children, node: _node, ...props}: MarkdownElementProps<"h6">) => (
    <BidiBlock as="h6" className="mt-4 text-sm font-semibold text-muted-foreground" {...props}>
      {children}
    </BidiBlock>
  ),
  li: ({children, node: _node, ...props}: MarkdownElementProps<"li">) => (
    <BidiBlock as="li" className="my-1" {...props}>
      {children}
    </BidiBlock>
  ),
  blockquote: ({children, node: _node, ...props}: MarkdownElementProps<"blockquote">) => (
    <BidiBlock as="blockquote" className="my-4 text-muted-foreground" {...props}>
      {children}
    </BidiBlock>
  ),
  th: ({children, node: _node, ...props}: MarkdownElementProps<"th">) => (
    <BidiBlock as="th" scope="col" {...props}>
      {children}
    </BidiBlock>
  ),
  td: ({children, node: _node, ...props}: MarkdownElementProps<"td">) => (
    <BidiBlock as="td" {...props}>
      {children}
    </BidiBlock>
  ),
  caption: ({children, node: _node, ...props}: MarkdownElementProps<"caption">) => (
    <BidiBlock as="caption" className="px-3 py-2 text-sm text-muted-foreground" {...props}>
      {children}
    </BidiBlock>
  ),
  table: ({children, node: _node, ...props}: MarkdownElementProps<"table">) => (
    <div className="markdown-table-wrap my-4" role="region" tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  ),
  strong: ({children, node: _node, ...props}: MarkdownElementProps<"strong">) => (
    <strong {...props}>{isolateInlineContent(children)}</strong>
  ),
  em: ({children, node: _node, ...props}: MarkdownElementProps<"em">) => (
    <em {...props}>{isolateInlineContent(children)}</em>
  ),
  del: ({children, node: _node, ...props}: MarkdownElementProps<"del">) => (
    <del {...props}>{isolateInlineContent(children)}</del>
  ),
  a: SafeLink,
  code: MarkdownCode,
  inlineCode: InlineCode,
} satisfies Components;

export interface MarkdownRendererProps {
  className?: string;
  copyable?: boolean;
  isStreaming?: boolean;
  source: string;
}

export function MarkdownRenderer({
  className,
  copyable = true,
  isStreaming = false,
  source,
}: MarkdownRendererProps) {
  const translations = useTranslations("Markdown");

  return (
    <div
      className={cn("group/message relative min-w-0", className)}
      data-testid="message-content"
    >
      <Streamdown
        className="markdown-content"
        components={markdownComponents}
        controls={{
          code: false,
          mermaid: false,
          table: {copy: true, download: false, fullscreen: false},
        }}
        dir="auto"
        isAnimating={isStreaming}
        linkSafety={{enabled: false}}
        mode={isStreaming ? "streaming" : "static"}
        plugins={{code}}
        translations={{
          copied: translations("copied"),
          copyCode: translations("copyCode"),
          copyLink: translations("externalLink"),
        }}
      >
        {source}
      </Streamdown>
      {copyable ? (
        <CopyMessageButton
          className="message-copy-action absolute -bottom-10 end-0"
          source={source}
        />
      ) : null}
    </div>
  );
}
