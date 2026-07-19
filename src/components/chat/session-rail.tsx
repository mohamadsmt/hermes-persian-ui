"use client";

import {
  Archive,
  ChartNoAxesColumn,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  FileSearch,
  LoaderCircle,
  MessageSquarePlus,
  MessageSquare,
  MessageCircleQuestion,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  TriangleAlert,
  Trash2,
  X,
  type LucideIcon,
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
  collapsed?: boolean;
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
    statusNeedsInput?: string;
    statusError?: string;
    statusStarting?: string;
    statusWorking?: string;
    statusUnread?: string;
    statusIdle?: string;
    collapse?: string;
    expand?: string;
  };
  canCreate?: boolean;
  canManage?: boolean;
  onCloseMobile?: () => void;
  onToggleCollapsed?: () => void;
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

type SessionIndicatorKind =
  | "needs-input"
  | "error"
  | "starting"
  | "working"
  | "unread"
  | "idle";

type SessionStatusLabels = Required<Pick<SessionRailProps["labels"],
  | "statusNeedsInput"
  | "statusError"
  | "statusStarting"
  | "statusWorking"
  | "statusUnread"
  | "statusIdle"
>>;

type SessionIndicator = {
  kind: SessionIndicatorKind;
  label: string;
  icon: LucideIcon;
  className: string;
  animated?: boolean;
};

function statusLabels(locale: string, labels: SessionRailProps["labels"]): SessionStatusLabels {
  const defaults = locale.startsWith("fa") ? {
    statusNeedsInput: "نیازمند پاسخ شما",
    statusError: "گفت‌وگو با خطا روبه‌رو شده است",
    statusStarting: "گفت‌وگو در حال شروع است",
    statusWorking: "گفت‌وگو در حال اجراست",
    statusUnread: "گفت‌وگو به‌روزرسانی خوانده‌نشده دارد",
    statusIdle: "گفت‌وگو آماده است",
  } : {
    statusNeedsInput: "Needs your response",
    statusError: "Conversation has an error",
    statusStarting: "Conversation is starting",
    statusWorking: "Conversation is working",
    statusUnread: "Conversation has unread updates",
    statusIdle: "Conversation is ready",
  };

  return {
    statusNeedsInput: labels.statusNeedsInput ?? defaults.statusNeedsInput,
    statusError: labels.statusError ?? defaults.statusError,
    statusStarting: labels.statusStarting ?? defaults.statusStarting,
    statusWorking: labels.statusWorking ?? defaults.statusWorking,
    statusUnread: labels.statusUnread ?? defaults.statusUnread,
    statusIdle: labels.statusIdle ?? defaults.statusIdle,
  };
}

function isLiveSession(session: SessionSummary): boolean {
  if (session.live !== undefined) return session.live;
  return session.status === "active" || session.runtimeStatus !== undefined;
}

function sessionIndicator(
  session: SessionSummary,
  labels: SessionStatusLabels,
): SessionIndicator | null {
  if (session.needsInput || session.runtimeStatus === "waiting") {
    return {
      kind: "needs-input",
      label: labels.statusNeedsInput,
      icon: MessageCircleQuestion,
      className: "text-warning-foreground",
    };
  }
  if (session.error) {
    return {
      kind: "error",
      label: labels.statusError,
      icon: TriangleAlert,
      className: "text-destructive",
    };
  }
  if (session.runtimeStatus === "starting") {
    return {
      kind: "starting",
      label: labels.statusStarting,
      icon: CircleDashed,
      className: "text-primary",
      animated: true,
    };
  }
  if (session.runtimeStatus === "working") {
    return {
      kind: "working",
      label: labels.statusWorking,
      icon: LoaderCircle,
      className: "text-primary",
      animated: true,
    };
  }
  if (session.unread) {
    return {
      kind: "unread",
      label: labels.statusUnread,
      icon: CircleCheck,
      className: "text-success",
    };
  }
  if (session.runtimeStatus === "idle" || isLiveSession(session)) {
    return {
      kind: "idle",
      label: labels.statusIdle,
      icon: CirclePause,
      className: "text-muted-foreground",
    };
  }
  return null;
}

function SessionStatusIndicator({
  indicator,
}: {
  indicator: SessionIndicator | null;
}) {
  if (!indicator) return null;
  const Icon = indicator.icon;
  return (
    <span
      aria-label={indicator.label}
      className={`inline-flex shrink-0 ${indicator.className}`}
      data-session-status={indicator.kind}
      data-testid="session-status-indicator"
      role="img"
      title={indicator.label}
    >
      <Icon
        aria-hidden="true"
        className={indicator.animated ? "animate-spin motion-reduce:animate-none" : undefined}
        size={14}
      />
    </span>
  );
}

export function SessionRail({
  sessions,
  activeSessionId,
  locale,
  labels,
  loading,
  mobileOpen,
  collapsed = false,
  canCreate = true,
  canManage = true,
  onCloseMobile,
  onToggleCollapsed,
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
  const compact = collapsed && !mobileOpen;
  const collapseLabel = labels.collapse ?? (locale.startsWith("fa") ? "جمع‌کردن نوار کناری" : "Collapse sidebar");
  const expandLabel = labels.expand ?? (locale.startsWith("fa") ? "بازکردن نوار کناری" : "Expand sidebar");
  const sessionStatusLabels = statusLabels(locale, labels);
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
    const deletable = active || !isLiveSession(session);
    const indicator = sessionIndicator(session, sessionStatusLabels);
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
          <span className="flex min-w-0 items-center gap-2">
            <SessionStatusIndicator indicator={indicator} />
            <span className="session-row__title bidi-block min-w-0">{session.title}</span>
          </span>
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
        className={`session-rail ${mobileOpen ? "session-rail--mobile-open" : ""} ${compact ? "session-rail--collapsed" : ""}`}
        aria-label={labels.title}
        data-testid="session-list"
        data-collapsed={compact ? "true" : "false"}
      >
        <header className="rail-header">
          <div className="rail-title-row">
            <h2 className={compact ? "sr-only" : undefined}>{labels.title}</h2>
            {onToggleCollapsed ? (
              <button
                type="button"
                className="icon-button rail-collapse-toggle"
                aria-label={collapsed ? expandLabel : collapseLabel}
                aria-pressed={collapsed}
                data-testid="session-rail-toggle"
                onClick={onToggleCollapsed}
              >
                {collapsed ? <PanelLeftOpen aria-hidden="true" size={18} /> : <PanelLeftClose aria-hidden="true" size={18} />}
              </button>
            ) : null}
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
            className={compact ? "icon-button rail-new-compact" : "button button--primary button--full"}
            onClick={onCreate}
            data-testid="new-session"
            disabled={!canCreate}
            aria-label={compact ? labels.newSession : undefined}
            title={compact ? labels.newSession : undefined}
          >
            <MessageSquarePlus aria-hidden="true" size={18} />
            {compact ? null : labels.newSession}
          </button>
          {compact ? null : (
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
          )}
        </header>

        <div className="session-rail__list">
          {compact ? (
            loading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <div className="session-skeleton session-skeleton--compact" key={index} aria-hidden="true" />
              ))
            ) : sessions.length ? (
              <div className="session-rail__compact-list">
                {sessions.map((session) => {
                  const active = session.storedId === activeSessionId;
                  const indicator = sessionIndicator(session, sessionStatusLabels);
                  return (
                    <button
                      key={session.storedId}
                      type="button"
                      className={`session-compact-button ${active ? "session-compact-button--active" : ""}`}
                      aria-current={active ? "page" : undefined}
                      aria-label={session.title}
                      title={session.title}
                      data-testid="session-item"
                      data-session-id={session.storedId}
                      onClick={() => onSelect(session)}
                      disabled={!canManage}
                    >
                      {indicator ? <SessionStatusIndicator indicator={indicator} /> : <MessageSquare aria-hidden="true" size={16} />}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rail-empty rail-empty--compact">
                <Archive aria-hidden="true" size={18} />
              </div>
            )
          ) : loading ? (
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
