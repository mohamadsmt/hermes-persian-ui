"use client";

import {
  Archive,
  ChartNoAxesColumn,
  CircleX,
  FileSearch,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { FormEvent, useMemo, useState, type ReactNode } from "react";

import type { SessionSearchHit } from "@/lib/hermes";

import {
  MAX_SESSION_SEARCH_QUERY,
  useSessionSearch,
} from "./session-search";
import type { SessionSummary } from "./ui-types";

type SessionRailProps = {
  sessions: SessionSummary[];
  activeSessionId?: string;
  locale: string;
  loading?: boolean;
  mobileOpen?: boolean;
  labels: {
    title: string;
    newSession: string;
    search: string;
    empty: string;
    noResults: string;
    rename: string;
    delete: string;
    close: string;
    usage: string;
    cancel: string;
    confirmDelete: string;
    confirmClose: string;
    closeDescription: string;
    renameTitle: string;
    searching?: string;
    searchUnavailable?: string;
    messageMatch?: string;
  };
  canCreate?: boolean;
  canManage?: boolean;
  onCloseMobile?: () => void;
  onCreate: () => void;
  onSelect: (session: SessionSummary) => void;
  onRename: (session: SessionSummary, title: string) => Promise<void>;
  onDelete: (session: SessionSummary) => Promise<void>;
  onClose?: (session: SessionSummary) => Promise<void>;
  onUsage?: (session: SessionSummary) => Promise<void>;
  searchProfile?: string;
  searchEnabled?: boolean;
  searchDebounceMs?: number;
  searchLimit?: number;
  onSearchCapabilityChange?: (support: "available" | "unavailable") => void;
  onSelectSearchResult?: (result: SessionSearchHit) => void;
  projectBrowser?: ReactNode;
  projectRecentSessions?: SessionSummary[];
};

export function SessionRail({
  sessions,
  activeSessionId,
  locale,
  labels,
  loading,
  mobileOpen,
  canCreate = true,
  canManage = true,
  onCloseMobile,
  onCreate,
  onSelect,
  onRename,
  onDelete,
  onClose,
  onUsage,
  searchProfile,
  searchEnabled,
  searchDebounceMs,
  searchLimit,
  onSearchCapabilityChange,
  onSelectSearchResult,
  projectBrowser,
  projectRecentSessions,
}: SessionRailProps) {
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [closeTarget, setCloseTarget] = useState<SessionSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const remoteSearch = useSessionSearch({
    debounceMs: searchDebounceMs,
    enabled: searchEnabled ?? Boolean(searchProfile && onSelectSearchResult),
    limit: searchLimit,
    onCapabilityChange: onSearchCapabilityChange,
    profile: searchProfile,
    query,
  });

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return sessions;
    return sessions.filter((session) => [
      session.title,
      session.model,
      session.profile,
      session.preview,
      session.cwd,
      session.storedId,
      session.runtimeId,
    ].some((value) => value?.toLocaleLowerCase().includes(normalized)));
  }, [query, sessions]);

  const visibleLocalIds = useMemo(() => {
    const ids = new Set<string>();
    filtered.forEach((session) => {
      ids.add(session.storedId);
      if (session.runtimeId) ids.add(session.runtimeId);
    });
    return ids;
  }, [filtered]);

  const unmatchedRemoteResults = useMemo(
    () => remoteSearch.results.filter((result) => (
      !visibleLocalIds.has(result.sessionId) &&
      (!result.lineageRoot || !visibleLocalIds.has(result.lineageRoot))
    )),
    [remoteSearch.results, visibleLocalIds],
  );
  const hasQuery = Boolean(query.trim());
  const flatSessions = hasQuery
    ? filtered
    : projectBrowser
      ? projectRecentSessions ?? []
      : filtered;
  const projectManagedSessions = useMemo(() => {
    if (!projectBrowser) return [];
    const recentIds = new Set((projectRecentSessions ?? []).map((session) => session.storedId));
    return sessions.filter((session) => !recentIds.has(session.storedId));
  }, [projectBrowser, projectRecentSessions, sessions]);
  const hasVisibleContent = hasQuery
    ? Boolean(flatSessions.length || unmatchedRemoteResults.length || remoteSearch.loading || remoteSearch.error)
    : Boolean(projectBrowser || flatSessions.length);

  function selectSearchHit(result: SessionSearchHit) {
    const local = sessions.find((session) => (
      session.storedId === result.sessionId ||
      session.runtimeId === result.sessionId ||
      session.storedId === result.lineageRoot ||
      session.runtimeId === result.lineageRoot
    ));
    if (local) onSelect(local);
    else onSelectSearchResult?.(result);
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameTarget || busy) return;
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (!title) return;
    setBusy(true);
    try {
      await onRename(renameTarget, title);
      setRenameTarget(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      await onDelete(deleteTarget);
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirmClose() {
    if (!closeTarget || !onClose || busy) return;
    setBusy(true);
    try {
      await onClose(closeTarget);
      setCloseTarget(null);
    } finally {
      setBusy(false);
    }
  }

  function renderSessionRow(session: SessionSummary) {
    const active = session.storedId === activeSessionId;
    const deletable = active || session.status !== "active";
    const messageMatch = remoteSearch.results.find((result) => (
      result.sessionId === session.storedId ||
      result.sessionId === session.runtimeId ||
      result.lineageRoot === session.storedId ||
      result.lineageRoot === session.runtimeId
    ));

    return (
      <div
        className={`session-row ${active ? "session-row--active" : ""}`}
        key={session.storedId}
        data-testid="session-item"
        data-session-id={session.storedId}
      >
        <button
          type="button"
          className="session-row__main"
          aria-current={active ? "page" : undefined}
          onClick={() => onSelect(session)}
          disabled={!canManage}
        >
          <span className="session-row__title bidi-block">{session.title}</span>
          <span className="session-row__meta">
            {session.model ? (
              <bdi dir="ltr" className="technical-inline">
                {session.model}
              </bdi>
            ) : null}
            {session.messageCount !== undefined ? (
              <span>{session.messageCount.toLocaleString(locale)}</span>
            ) : null}
          </span>
          {messageMatch?.snippet ? (
            <span
              className="line-clamp-2 text-xs leading-5 text-muted-foreground"
              data-testid="session-search-snippet"
              dir="auto"
            >
              {messageMatch.snippet}
            </span>
          ) : null}
        </button>
        {canManage ? (
          <button
            type="button"
            className="icon-button session-row__actions"
            aria-label={`${labels.rename} / ${labels.delete}`}
            data-testid="session-actions"
            onClick={() => setMenuId((current) => (current === session.storedId ? null : session.storedId))}
          >
            <MoreHorizontal aria-hidden="true" size={18} />
          </button>
        ) : null}
        {menuId === session.storedId ? (
          <div className="session-menu" role="menu">
            {active && onUsage ? (
              <button
                type="button"
                role="menuitem"
                data-testid="session-usage"
                onClick={() => {
                  setMenuId(null);
                  void onUsage(session);
                }}
              >
                <ChartNoAxesColumn aria-hidden="true" size={16} />
                {labels.usage}
              </button>
            ) : null}
            {active && onClose ? (
              <button
                type="button"
                role="menuitem"
                data-testid="close-session"
                onClick={() => {
                  setCloseTarget(session);
                  setMenuId(null);
                }}
              >
                <CircleX aria-hidden="true" size={16} />
                {labels.close}
              </button>
            ) : null}
            <button
              type="button"
              role="menuitem"
              data-testid="rename-session"
              onClick={() => {
                setRenameTarget(session);
                setMenuId(null);
              }}
            >
              <Pencil aria-hidden="true" size={16} />
              {labels.rename}
            </button>
            {deletable ? (
              <button
                type="button"
                role="menuitem"
                className="danger-text"
                data-testid="delete-session"
                onClick={() => {
                  setDeleteTarget(session);
                  setMenuId(null);
                }}
              >
                <Trash2 aria-hidden="true" size={16} />
                {labels.delete}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <aside
        className={`session-rail ${mobileOpen ? "session-rail--mobile-open" : ""}`}
        aria-label={labels.title}
        data-testid="session-list"
      >
        <header className="rail-header">
          <div className="rail-title-row">
            <h2>{labels.title}</h2>
            {onCloseMobile ? (
              <button
                type="button"
                className="icon-button rail-mobile-close"
                onClick={onCloseMobile}
                aria-label={labels.close}
              >
                <X aria-hidden="true" size={20} />
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="button button--primary button--full"
            onClick={onCreate}
            data-testid="new-session"
            disabled={!canCreate}
          >
            <MessageSquarePlus aria-hidden="true" size={18} />
            {labels.newSession}
          </button>
          <label className="session-search">
            <Search aria-hidden="true" size={17} />
            <span className="sr-only">{labels.search}</span>
            <input
              value={query}
              maxLength={MAX_SESSION_SEARCH_QUERY}
              onChange={(event) => setQuery(event.target.value.slice(0, MAX_SESSION_SEARCH_QUERY))}
              placeholder={labels.search}
              data-testid="session-search"
              dir="auto"
            />
          </label>
        </header>

        <div className="session-rail__list">
          {loading ? (
            Array.from({ length: 5 }).map((_, index) => (
              <div className="session-skeleton" key={index} aria-hidden="true" />
            ))
          ) : hasVisibleContent ? (
            <>
              {!hasQuery && projectBrowser ? (
                <div className="p-2" data-testid="session-projects">
                  {projectBrowser}
                </div>
              ) : null}

              {projectBrowser && projectManagedSessions.length ? (
                <details
                  className="mx-2 mb-2 rounded-xl border border-border bg-surface"
                  data-testid="project-session-management"
                  hidden={hasQuery}
                >
                  <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-muted-foreground marker:hidden">
                    <span>{locale.startsWith("fa") ? "مدیریت گفت‌وگوها" : "Manage conversations"}</span>
                    <span>{projectManagedSessions.length.toLocaleString(locale)}</span>
                  </summary>
                  <div className="border-t border-border p-1">
                    {projectManagedSessions.map(renderSessionRow)}
                  </div>
                </details>
              ) : null}

              {!hasQuery && projectBrowser && flatSessions.length ? (
                <p className="border-t border-border px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground">
                  {locale.startsWith("fa") ? "گفت‌وگوهای اخیر" : "Recent conversations"}
                </p>
              ) : null}

              {flatSessions.map(renderSessionRow)}

            {unmatchedRemoteResults.length ? (
              <section
                aria-label={labels.messageMatch ?? (locale.startsWith("fa") ? "نتیجه در پیام‌ها" : "Matches in messages")}
                className="mt-2 border-t border-border pt-2"
                data-testid="session-search-results"
              >
                <p className="px-3 py-1 text-xs font-medium text-muted-foreground">
                  {labels.messageMatch ?? (locale.startsWith("fa") ? "نتیجه در پیام‌ها" : "Matches in messages")}
                </p>
                {unmatchedRemoteResults.map((result) => (
                  <button
                    className="flex min-h-16 w-full flex-col items-start gap-1 rounded-xl px-3 py-2 text-start hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="session-search-result"
                    key={result.lineageRoot || result.sessionId}
                    onClick={() => selectSearchHit(result)}
                    type="button"
                  >
                    <span className="flex w-full items-center gap-2 text-xs text-muted-foreground">
                      <FileSearch aria-hidden="true" size={14} />
                      {result.model ? <bdi className="technical-inline" dir="ltr">{result.model}</bdi> : null}
                      {result.role ? <span>{result.role}</span> : null}
                    </span>
                    <span className="line-clamp-2 text-sm leading-6" dir="auto">
                      {result.snippet || result.sessionId}
                    </span>
                  </button>
                ))}
              </section>
            ) : null}

            {remoteSearch.loading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground" role="status">
                <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={15} />
                {labels.searching ?? (locale.startsWith("fa") ? "در حال جست‌وجو…" : "Searching…")}
              </div>
            ) : null}

            {remoteSearch.error ? (
              <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
                {labels.searchUnavailable ?? (locale.startsWith("fa") ? "جست‌وجوی متن پیام‌ها در دسترس نیست." : "Message search is unavailable.")}
              </p>
            ) : null}
            </>
          ) : (
            <div className="rail-empty">
              <Archive aria-hidden="true" size={24} />
              <p>{query ? labels.noResults : labels.empty}</p>
            </div>
          )}
        </div>
      </aside>

      {renameTarget ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title">
            <h3 id="rename-title">{labels.renameTitle}</h3>
            <form onSubmit={submitRename}>
              <input
                name="title"
                defaultValue={renameTarget.title}
                autoFocus
                data-testid="session-title"
                dir="auto"
              />
              <div className="modal__actions">
                <button type="button" className="button button--ghost" onClick={() => setRenameTarget(null)}>
                  {labels.cancel}
                </button>
                <button type="submit" className="button button--primary" disabled={busy}>
                  {labels.rename}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <h3 id="delete-title">{labels.confirmDelete}</h3>
            <p className="bidi-block">{deleteTarget.title}</p>
            <div className="modal__actions">
              <button type="button" className="button button--ghost" onClick={() => setDeleteTarget(null)}>
                {labels.cancel}
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => void confirmDelete()}
                disabled={busy}
                data-testid="confirm-delete"
              >
                {labels.delete}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {closeTarget ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="close-title">
            <h3 id="close-title">{labels.confirmClose}</h3>
            <p>{labels.closeDescription}</p>
            <p className="bidi-block">{closeTarget.title}</p>
            <div className="modal__actions">
              <button type="button" className="button button--ghost" onClick={() => setCloseTarget(null)}>
                {labels.cancel}
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => void confirmClose()}
                disabled={busy}
                data-testid="confirm-close"
              >
                {labels.close}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
