"use client";

import {
  Archive,
  ChartNoAxesColumn,
  CircleX,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";

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
}: SessionRailProps) {
  const [query, setQuery] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [closeTarget, setCloseTarget] = useState<SessionSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return sessions;
    return sessions.filter((session) =>
      session.title.toLocaleLowerCase().includes(normalized),
    );
  }, [query, sessions]);

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
              onChange={(event) => setQuery(event.target.value)}
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
          ) : filtered.length ? (
            filtered.map((session) => {
              const active = session.storedId === activeSessionId;
              const deletable = active || session.status !== "active";
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
            })
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
