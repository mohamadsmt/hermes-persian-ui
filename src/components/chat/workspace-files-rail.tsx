"use client";

import {
  ChevronLeft,
  Download,
  File,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  Paperclip,
  PanelLeftClose,
  PanelsTopLeft,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import type { WorkspaceEntry } from "@/lib/hermes";

export interface WorkspaceFilesRailProps {
  labels?: Partial<WorkspaceFilesLabels>;
  locale: string;
  mobileOpen?: boolean;
  onAttach?: (entry: WorkspaceEntry) => void | Promise<void>;
  onCapabilityChange?: (
    operation: "list" | "read" | "validate",
    support: "available" | "unavailable",
  ) => void;
  artifactCount?: number;
  onClose: () => void;
  onOpenArtifacts?: () => void;
  open: boolean;
  profile: string;
  sessionId?: string;
  width?: number;
  refreshKey?: number;
}

export interface WorkspaceFilesLabels {
  attach: string;
  back: string;
  close: string;
  download: string;
  empty: string;
  error: string;
  loading: string;
  metadataOnly: string;
  modified: string;
  noSession: string;
  refresh: string;
  size: string;
  title: string;
}

interface BrowseState {
  contextKey: string;
  entries: WorkspaceEntry[];
  error: string | null;
  loading: boolean;
  parent: string | null;
  path: string;
  rootName: string;
}

interface WorkspacePreview extends WorkspaceEntry {
  content?: string;
  dataUrl?: string;
  kind: "image" | "metadata" | "text";
  truncated?: boolean;
}

interface PreviewState {
  entry: WorkspaceEntry;
  error: string | null;
  file: WorkspacePreview | null;
  loading: boolean;
}

const EMPTY_BROWSE: BrowseState = {
  contextKey: "",
  entries: [],
  error: null,
  loading: false,
  parent: null,
  path: "",
  rootName: "workspace",
};

export function WorkspaceFilesRail({
  labels: labelOverrides,
  locale,
  mobileOpen = false,
  onAttach,
  onCapabilityChange,
  artifactCount = 0,
  onClose,
  onOpenArtifacts,
  open,
  profile,
  sessionId,
  width = 352,
  refreshKey = 0,
}: WorkspaceFilesRailProps) {
  const labels = workspaceLabels(locale, labelOverrides);
  const concreteProfile = profile.trim();
  const contextKey = `${concreteProfile}\u0000${sessionId ?? ""}`;
  const [browse, setBrowse] = useState<BrowseState>(EMPTY_BROWSE);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [attachingPath, setAttachingPath] = useState<string | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const currentPath = browse.contextKey === contextKey ? browse.path : "";

  useEffect(() => {
    if ((!open && !mobileOpen) || !sessionId || !concreteProfile || concreteProfile === "all") return;
    const controller = new AbortController();
    const params = workspaceParams(concreteProfile, sessionId, currentPath);
    const validateUrl = `/api/hermes/workspace/validate?${params.toString()}`;
    const listUrl = `/api/hermes/workspace/list?${params.toString()}`;

    Promise.all([
      fetch(validateUrl, { cache: "no-store", signal: controller.signal })
        .then((response) => reportWorkspaceResponse(response, "validate", onCapabilityChange))
        .then(requireJson),
      fetch(listUrl, { cache: "no-store", signal: controller.signal })
        .then((response) => reportWorkspaceResponse(response, "list", onCapabilityChange))
        .then(requireJson),
    ])
      .then(([validation, listing]) => {
        if (controller.signal.aborted) return;
        const parsed = parseWorkspaceListing(listing, concreteProfile, sessionId);
        const rootName = parseRootName(validation) || "workspace";
        setBrowse({ ...parsed, contextKey, loading: false, rootName });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setBrowse((current) => ({
          ...(current.contextKey === contextKey ? current : EMPTY_BROWSE),
          contextKey,
          error: error instanceof Error ? error.message : labels.error,
          loading: false,
          path: currentPath,
        }));
      });

    return () => controller.abort();
  }, [concreteProfile, contextKey, currentPath, labels.error, mobileOpen, onCapabilityChange, open, refreshKey, sessionId]);

  useEffect(() => () => previewAbort.current?.abort(), []);

  const breadcrumbs = useMemo(
    () => workspaceBreadcrumbs(currentPath, browse.contextKey === contextKey ? browse.rootName : "workspace"),
    [browse.contextKey, browse.rootName, contextKey, currentPath],
  );

  function navigate(path: string) {
    const safePath = safeWorkspaceRelativePath(path);
    if (safePath === null) return;
    previewAbort.current?.abort();
    setPreview(null);
    setBrowse({
      contextKey,
      entries: [],
      error: null,
      loading: true,
      parent: safePath ? parentPath(safePath) : null,
      path: safePath,
      rootName: browse.rootName,
    });
  }

  async function selectEntry(entry: WorkspaceEntry) {
    if (entry.isDirectory) {
      navigate(entry.path);
      return;
    }
    const safePath = safeWorkspaceRelativePath(entry.path);
    if (safePath === null || !sessionId) return;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setPreview({ entry, error: null, file: null, loading: true });
    try {
      const params = workspaceParams(concreteProfile, sessionId, safePath);
      const payload = await fetch(`/api/hermes/workspace/read?${params.toString()}`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then((response) => reportWorkspaceResponse(response, "read", onCapabilityChange))
        .then(requireJson);
      if (controller.signal.aborted) return;
      setPreview({ entry, error: null, file: parseWorkspacePreview(payload, entry), loading: false });
    } catch (error) {
      if (controller.signal.aborted) return;
      setPreview({
        entry,
        error: error instanceof Error ? error.message : labels.error,
        file: null,
        loading: false,
      });
    }
  }

  async function attach(entry: WorkspaceEntry) {
    if (!onAttach || attachingPath) return;
    setAttachingPath(entry.path);
    try {
      await onAttach(entry);
    } finally {
      setAttachingPath(null);
    }
  }

  if (!open && !mobileOpen) return null;

  const activeBrowse = browse.contextKey === contextKey ? browse : { ...EMPTY_BROWSE, loading: Boolean(sessionId) };
  const canBrowse = Boolean(sessionId && concreteProfile && concreteProfile !== "all");
  const selectedDownloadUrl = preview?.entry && sessionId
    ? workspaceDownloadUrl(concreteProfile, sessionId, preview.entry.path)
    : null;

  return (
    <aside
      aria-label={labels.title}
      className={`artifact-rail ${mobileOpen ? "artifact-rail--mobile-open" : ""}`}
      data-testid="workspace-files-rail"
      style={{ "--artifact-width": `${width}px` } as CSSProperties}
    >
      <header className="rail-title-row artifact-rail__header">
        <h2 className="flex items-center gap-2">
          <FolderOpen aria-hidden="true" size={17} />
          {labels.title}
        </h2>
        {onOpenArtifacts && artifactCount > 0 ? (
          <button
            aria-label={`${artifactCount.toLocaleString(locale)} artifacts`}
            className="icon-button"
            onClick={onOpenArtifacts}
            type="button"
          >
            <PanelsTopLeft aria-hidden="true" size={18} />
            <span className="sr-only">{artifactCount.toLocaleString(locale)}</span>
          </button>
        ) : null}
        <button aria-label={labels.close} className="icon-button" onClick={onClose} type="button">
          <PanelLeftClose aria-hidden="true" className="header-wide-action" size={19} />
          <X aria-hidden="true" className="header-mobile-action" size={20} />
        </button>
      </header>

      {!canBrowse ? (
        <div className="rail-empty">
          <Folder aria-hidden="true" size={24} />
          <p>{labels.noSession}</p>
        </div>
      ) : (
        <>
          <div className="flex min-h-11 items-center gap-1 overflow-x-auto border-b border-border px-2" aria-label={labels.title}>
            {breadcrumbs.map((crumb, index) => (
              <span className="flex shrink-0 items-center" key={crumb.path || "root"}>
                {index ? <span aria-hidden="true" className="px-0.5 text-muted-foreground">/</span> : null}
                <button
                  className="max-w-32 truncate rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                  dir="auto"
                  onClick={() => navigate(crumb.path)}
                  type="button"
                >
                  {crumb.name}
                </button>
              </span>
            ))}
            <button
              aria-label={labels.refresh}
              className="ms-auto grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => navigate(currentPath)}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={15} />
            </button>
          </div>

          {preview ? (
            <WorkspaceFilePreview
              attaching={attachingPath === preview.entry.path}
              downloadUrl={selectedDownloadUrl}
              labels={labels}
              locale={locale}
              onAttach={onAttach ? () => void attach(preview.entry) : undefined}
              onBack={() => setPreview(null)}
              preview={preview}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {activeBrowse.loading ? (
                <div className="rail-empty" role="status">
                  <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={22} />
                  <p>{labels.loading}</p>
                </div>
              ) : activeBrowse.error ? (
                <div className="rail-empty" role="alert">
                  <Folder aria-hidden="true" size={24} />
                  <p>{labels.error}</p>
                  <Button onClick={() => navigate(currentPath)} size="sm" variant="secondary">{labels.refresh}</Button>
                </div>
              ) : activeBrowse.entries.length ? (
                <div className="grid gap-0.5" data-testid="workspace-file-list">
                  {activeBrowse.parent !== null ? (
                    <button
                      className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-start text-sm text-muted-foreground hover:bg-muted"
                      onClick={() => navigate(activeBrowse.parent ?? "")}
                      type="button"
                    >
                      <ChevronLeft aria-hidden="true" size={16} />
                      {labels.back}
                    </button>
                  ) : null}
                  {activeBrowse.entries.map((entry) => {
                    const Icon = entry.isDirectory ? Folder : entry.mimeType?.startsWith("image/") ? FileImage : entry.previewable ? FileText : File;
                    return (
                      <button
                        className="flex min-h-12 min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid="workspace-entry"
                        key={entry.path}
                        onClick={() => void selectEntry(entry)}
                        type="button"
                      >
                        <Icon aria-hidden="true" className={entry.isDirectory ? "text-primary" : "text-muted-foreground"} size={18} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm" dir="auto">{entry.name}</span>
                          {!entry.isDirectory && entry.size !== undefined ? (
                            <span className="block text-xs text-muted-foreground">{formatBytes(entry.size, locale)}</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="rail-empty">
                  <Folder aria-hidden="true" size={24} />
                  <p>{labels.empty}</p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function WorkspaceFilePreview({
  attaching,
  downloadUrl,
  labels,
  locale,
  onAttach,
  onBack,
  preview,
}: {
  attaching: boolean;
  downloadUrl: string | null;
  labels: WorkspaceFilesLabels;
  locale: string;
  onAttach?: () => void;
  onBack: () => void;
  preview: PreviewState;
}) {
  const file = preview.file;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-12 items-center gap-2 border-b border-border px-2">
        <button aria-label={labels.back} className="icon-button" onClick={onBack} type="button">
          <ChevronLeft aria-hidden="true" size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" dir="auto">{preview.entry.name}</span>
        {onAttach ? (
          <button
            aria-label={labels.attach}
            className="icon-button"
            disabled={attaching}
            onClick={onAttach}
            type="button"
          >
            {attaching ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={17} /> : <Paperclip aria-hidden="true" size={17} />}
          </button>
        ) : null}
        {downloadUrl ? (
          <a aria-label={labels.download} className="icon-button grid place-items-center" download={preview.entry.name} href={downloadUrl}>
            <Download aria-hidden="true" size={17} />
          </a>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-surface p-3" data-testid="workspace-preview">
        {preview.loading ? (
          <div className="rail-empty" role="status"><LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={22} /><p>{labels.loading}</p></div>
        ) : preview.error ? (
          <p className="rounded-xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive" role="alert">{labels.error}</p>
        ) : file?.kind === "text" && typeof file.content === "string" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-6" dir="auto">{file.content}</pre>
        ) : file?.kind === "image" && safeRasterDataUrl(file.dataUrl) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={file.name} className="mx-auto max-h-full max-w-full rounded-lg object-contain" src={file.dataUrl} />
        ) : (
          <div className="grid gap-3 rounded-xl border border-border bg-background p-4 text-sm">
            <File aria-hidden="true" className="text-muted-foreground" size={28} />
            <p>{labels.metadataOnly}</p>
            <dl className="grid gap-2 text-xs text-muted-foreground">
              {preview.entry.size !== undefined ? <div className="flex justify-between gap-3"><dt>{labels.size}</dt><dd>{formatBytes(preview.entry.size, locale)}</dd></div> : null}
              {preview.entry.modifiedAt !== undefined ? <div className="flex justify-between gap-3"><dt>{labels.modified}</dt><dd>{formatDate(preview.entry.modifiedAt, locale)}</dd></div> : null}
              {preview.entry.mimeType ? <div className="flex justify-between gap-3"><dt>Type</dt><dd><bdi dir="ltr">{preview.entry.mimeType}</bdi></dd></div> : null}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

export function safeWorkspaceRelativePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[A-Za-z]:/u.test(trimmed) ||
    trimmed.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

export function workspaceDownloadUrl(profile: string, sessionId: string, path: string): string | null {
  const safePath = safeWorkspaceRelativePath(path);
  const concreteProfile = profile.trim();
  const concreteSessionId = sessionId.trim();
  if (safePath === null || !safePath || !concreteProfile || concreteProfile === "all" || !concreteSessionId) return null;
  return `/api/hermes/workspace/download?${workspaceParams(concreteProfile, concreteSessionId, safePath).toString()}`;
}

function workspaceParams(profile: string, sessionId: string, path: string): URLSearchParams {
  return new URLSearchParams({ profile, sessionId, path });
}

async function requireJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Workspace request failed (${response.status})`);
  return response.json();
}

function reportWorkspaceResponse(
  response: Response,
  operation: "list" | "read" | "validate",
  onCapabilityChange: WorkspaceFilesRailProps["onCapabilityChange"],
): Response {
  if (response.ok) onCapabilityChange?.(operation, "available");
  else if (response.status === 404 || response.status === 405) {
    onCapabilityChange?.(operation, "unavailable");
  }
  return response;
}

function parseWorkspaceListing(value: unknown, profile: string, sessionId: string): Omit<BrowseState, "contextKey" | "rootName"> {
  if (!value || typeof value !== "object") throw new Error("Invalid workspace response");
  const raw = value as Record<string, unknown>;
  if (raw.profile !== profile || raw.sessionId !== sessionId || typeof raw.path !== "string") {
    throw new Error("Workspace response did not match the active session");
  }
  const path = safeWorkspaceRelativePath(raw.path);
  if (path === null) throw new Error("Workspace returned an unsafe path");
  const entries = Array.isArray(raw.entries) ? raw.entries.flatMap(parseWorkspaceEntry) : [];
  const parent = raw.parent === null ? null : typeof raw.parent === "string" ? safeWorkspaceRelativePath(raw.parent) : parentPath(path);
  if (parent === null && path) throw new Error("Workspace returned an unsafe parent path");
  return { entries, error: null, loading: false, parent, path };
}

function parseWorkspaceEntry(value: unknown): WorkspaceEntry[] {
  if (!value || typeof value !== "object") return [];
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name : "";
  const path = typeof raw.path === "string" ? safeWorkspaceRelativePath(raw.path) : null;
  if (!name || path === null || !path || path.split("/").at(-1) !== name) return [];
  return [{
    name,
    path,
    isDirectory: raw.isDirectory === true,
    size: typeof raw.size === "number" && raw.size >= 0 ? raw.size : undefined,
    modifiedAt: typeof raw.modifiedAt === "number" && Number.isFinite(raw.modifiedAt) ? raw.modifiedAt : undefined,
    mimeType: typeof raw.mimeType === "string" ? raw.mimeType : undefined,
    previewable: raw.previewable === true,
  }];
}

function parseWorkspacePreview(value: unknown, expected: WorkspaceEntry): WorkspacePreview {
  if (!value || typeof value !== "object") throw new Error("Invalid workspace preview");
  const file = (value as Record<string, unknown>).file;
  if (!file || typeof file !== "object") throw new Error("Invalid workspace preview");
  const raw = file as Record<string, unknown>;
  if (raw.path !== expected.path || raw.name !== expected.name) throw new Error("Workspace preview did not match the selected file");
  const kind = raw.kind === "text" || raw.kind === "image" ? raw.kind : "metadata";
  return {
    ...expected,
    kind,
    previewable: raw.previewable === true,
    content: kind === "text" && typeof raw.content === "string" ? raw.content : undefined,
    dataUrl: kind === "image" && typeof raw.dataUrl === "string" ? raw.dataUrl : undefined,
    truncated: raw.truncated === true,
  };
}

function parseRootName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const root = (value as Record<string, unknown>).root;
  if (!root || typeof root !== "object") return null;
  const name = (root as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim().slice(0, 255) : null;
}

function workspaceBreadcrumbs(path: string, rootName: string): Array<{ name: string; path: string }> {
  const crumbs = [{ name: rootName, path: "" }];
  let current = "";
  path.split("/").filter(Boolean).forEach((name) => {
    current = current ? `${current}/${name}` : name;
    crumbs.push({ name, path: current });
  });
  return crumbs;
}

function parentPath(path: string): string | null {
  if (!path) return null;
  const segments = path.split("/");
  segments.pop();
  return segments.join("/");
}

function safeRasterDataUrl(value: string | undefined): boolean {
  return typeof value === "string" && /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/iu.test(value);
}

function formatBytes(value: number, locale: string): string {
  if (value < 1_024) return `${value.toLocaleString(locale)} B`;
  if (value < 1_048_576) return `${(value / 1_024).toLocaleString(locale, { maximumFractionDigits: 1 })} KiB`;
  return `${(value / 1_048_576).toLocaleString(locale, { maximumFractionDigits: 1 })} MiB`;
}

function formatDate(value: number, locale: string): string {
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(milliseconds);
}

function workspaceLabels(locale: string, overrides: WorkspaceFilesRailProps["labels"]): WorkspaceFilesLabels {
  const defaults: WorkspaceFilesLabels = locale.startsWith("fa") ? {
    attach: "پیوست به گفت‌وگو",
    back: "بازگشت",
    close: "بستن فایل‌ها",
    download: "دریافت فایل",
    empty: "این پوشه خالی است.",
    error: "خواندن فایل‌های این گفت‌وگو ممکن نیست.",
    loading: "در حال خواندن فایل‌ها…",
    metadataOnly: "پیش‌نمایش امن برای این فایل موجود نیست؛ می‌توانید آن را دریافت یا به گفت‌وگو پیوست کنید.",
    modified: "آخرین تغییر",
    noSession: "برای مرور فایل‌ها یک گفت‌وگوی دارای پوشه کاری را باز کنید.",
    refresh: "تازه‌سازی",
    size: "حجم",
    title: "فایل‌های پروژه",
  } : {
    attach: "Attach to conversation",
    back: "Back",
    close: "Close files",
    download: "Download file",
    empty: "This folder is empty.",
    error: "Files for this conversation could not be read.",
    loading: "Loading files…",
    metadataOnly: "A safe preview is unavailable. You can download the file or attach it to the conversation.",
    modified: "Modified",
    noSession: "Open a conversation with a persisted working directory to browse files.",
    refresh: "Refresh",
    size: "Size",
    title: "Project files",
  };
  return { ...defaults, ...overrides };
}
