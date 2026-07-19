"use client";

import { Menu, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { useWorkspaceLayoutStore } from "@/store/workspace-layout-store";

export interface WorkspaceNavigationItem {
  active: boolean;
  href: string;
  icon: LucideIcon;
  key: string;
  label: string;
}

interface WorkspaceNavigationProps {
  closeLabel: string;
  items: readonly WorkspaceNavigationItem[];
  menuLabel: string;
  openLabel: string;
  workspaceLabel: string;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("hidden"));
}

export function WorkspaceNavigation({
  closeLabel,
  items,
  menuLabel,
  openLabel,
  workspaceLabel,
}: WorkspaceNavigationProps) {
  const mobilePanel = useWorkspaceLayoutStore((state) => state.mobilePanel);
  const setMobilePanel = useWorkspaceLayoutStore(
    (state) => state.setMobilePanel,
  );
  const open = mobilePanel === "navigation";
  const navigationId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activeLinkRef = useRef<HTMLAnchorElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const restoreFocus = useCallback(() => {
    queueMicrotask(() => {
      const target = restoreFocusRef.current ?? triggerRef.current;
      target?.focus();
    });
  }, []);

  const closeNavigation = useCallback(
    (shouldRestoreFocus = true) => {
      setMobilePanel(null);
      if (shouldRestoreFocus) restoreFocus();
    },
    [restoreFocus, setMobilePanel],
  );

  const openNavigation = useCallback(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : triggerRef.current;
    setMobilePanel("navigation");
  }, [setMobilePanel]);

  useEffect(() => {
    if (!open) return;
    (activeLinkRef.current ?? focusableElements(surfaceRef.current!)[0])?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeNavigation();
        return;
      }
      if (event.key !== "Tab" || !surfaceRef.current) return;

      const focusable = focusableElements(surfaceRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !surfaceRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeNavigation, open]);

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    openNavigation();
  };

  return (
    <div className={`workspace-nav ${open ? "workspace-nav--open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="workspace-nav__mobile-trigger"
        aria-controls={navigationId}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={openLabel}
        title={openLabel}
        onClick={openNavigation}
        onKeyDown={handleTriggerKeyDown}
      >
        <Menu aria-hidden="true" size={19} />
      </button>

      {open ? (
        <button
          type="button"
          className="workspace-nav__scrim"
          tabIndex={-1}
          aria-label={closeLabel}
          onClick={() => closeNavigation()}
        />
      ) : null}

      <div
        ref={surfaceRef}
        id={navigationId}
        className="workspace-nav__surface"
        role={open ? "dialog" : undefined}
        aria-modal={open ? "true" : undefined}
        aria-label={open ? menuLabel : undefined}
      >
        <div className="workspace-nav__mobile-header">
          <span>{menuLabel}</span>
          <button
            type="button"
            className="workspace-nav__close"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={() => closeNavigation()}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        <nav className="workspace-nav__links" aria-label={workspaceLabel}>
          {items.map(({ active, href, icon: Icon, key, label }) => (
            <Link
              key={key}
              ref={active ? activeLinkRef : undefined}
              href={href}
              className={`workspace-nav__item ${active ? "workspace-nav__item--active" : ""}`}
              aria-current={active ? "page" : undefined}
              aria-label={label}
              title={label}
              onClick={() => closeNavigation(false)}
            >
              <Icon aria-hidden="true" size={19} />
              <span className="workspace-nav__label" aria-hidden="true">
                {label}
              </span>
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}
