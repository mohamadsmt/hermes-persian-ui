"use client";

import { Code2, FileDiff, FileText, ImageIcon, PanelLeftClose, X } from "lucide-react";
import { PointerEvent as ReactPointerEvent } from "react";

import { MarkdownRenderer } from "./markdown-renderer";
import type { Artifact } from "./ui-types";

type ArtifactRailProps = {
  artifacts: Artifact[];
  selectedId: string | null;
  open: boolean;
  mobileOpen?: boolean;
  width: number;
  labels: {
    title: string;
    empty: string;
    close: string;
    resize: string;
    previewUnavailable: string;
  };
  onSelect: (id: string) => void;
  onClose: () => void;
  onWidthChange: (width: number) => void;
};

const kindIcon = {
  markdown: FileText,
  text: FileText,
  code: Code2,
  diff: FileDiff,
  image: ImageIcon,
  html: Code2,
};

export function ArtifactRail({
  artifacts,
  selectedId,
  open,
  mobileOpen,
  width,
  labels,
  onSelect,
  onClose,
  onWidthChange,
}: ArtifactRailProps) {
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts[0];

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = width;
    const direction = document.documentElement.dir === "rtl" ? 1 : -1;
    const onMove = (moveEvent: PointerEvent) => {
      onWidthChange(startWidth + (moveEvent.clientX - startX) * direction);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  if (!open && !mobileOpen) return null;

  return (
    <aside
      className={`artifact-rail ${mobileOpen ? "artifact-rail--mobile-open" : ""}`}
      style={{ "--artifact-width": `${width}px` } as React.CSSProperties}
      aria-label={labels.title}
      data-testid="artifact-rail"
    >
      <button
        type="button"
        className="artifact-resizer"
        aria-label={labels.resize}
        onPointerDown={beginResize}
      />
      <header className="rail-title-row artifact-rail__header">
        <h2>{labels.title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label={labels.close}>
          <PanelLeftClose aria-hidden="true" className="header-wide-action" size={19} />
          <X aria-hidden="true" className="header-mobile-action" size={20} />
        </button>
      </header>
      {artifacts.length ? (
        <>
          <nav className="artifact-tabs" aria-label={labels.title}>
            {artifacts.map((artifact) => {
              const Icon = kindIcon[artifact.kind];
              return (
                <button
                  type="button"
                  key={artifact.id}
                  aria-current={selected?.id === artifact.id ? "true" : undefined}
                  onClick={() => onSelect(artifact.id)}
                >
                  <Icon aria-hidden="true" size={16} />
                  <span dir="auto">{artifact.title}</span>
                </button>
              );
            })}
          </nav>
          {selected ? <ArtifactPreview artifact={selected} labels={labels} /> : null}
        </>
      ) : (
        <div className="rail-empty">
          <FileText aria-hidden="true" size={24} />
          <p>{labels.empty}</p>
        </div>
      )}
    </aside>
  );
}

function ArtifactPreview({ artifact, labels }: { artifact: Artifact; labels: ArtifactRailProps["labels"] }) {
  if (artifact.kind === "markdown") {
    return (
      <div className="artifact-preview artifact-preview--document">
        <MarkdownRenderer source={artifact.content} />
      </div>
    );
  }
  if (artifact.kind === "code" || artifact.kind === "diff" || artifact.kind === "text") {
    const language = artifact.language ?? (artifact.kind === "diff" ? "diff" : "text");
    return (
      <div className="artifact-preview artifact-preview--code">
        <MarkdownRenderer
          copyable={false}
          source={artifactCodeMarkdown(artifact.content, language, artifact.title)}
        />
      </div>
    );
  }
  if (artifact.kind === "image") {
    return (
      <div className="artifact-preview artifact-preview--image">
        {/* Hermes supplies an already validated local/data URL; the rail does not proxy remote credentials. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={artifact.content} alt={artifact.title} />
      </div>
    );
  }
  if (artifact.kind === "html") {
    return (
      <div className="artifact-preview artifact-preview--html">
        <iframe
          title={artifact.title}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={artifact.content}
        />
      </div>
    );
  }
  return <p>{labels.previewUnavailable}</p>;
}

function artifactCodeMarkdown(source: string, language: string, filename: string): string {
  const longestFence = Math.max(0, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  const safeLanguage = /^[A-Za-z0-9_+-]+$/.test(language) ? language : "text";
  // Markdown code-fence metadata has no portable escaping contract. Keep the
  // exact filename when it is safe; the artifact tab still labels unusual names.
  const title = !/["\r\n]/u.test(filename) ? ` filename="${filename}"` : "";
  return `${fence}${safeLanguage}${title}\n${source}\n${fence}`;
}
