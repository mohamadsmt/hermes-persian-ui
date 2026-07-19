"use client";

import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

export const WORKSPACE_LAYOUT_STORAGE_KEY = "hermes-ui:layout:v1";

export type WorkspaceMobilePanel =
  | "session"
  | "inspector"
  | "navigation"
  | null;

export interface WorkspaceLayoutPreferences {
  sessionRailCollapsed: boolean;
  inspectorPinned: boolean;
  inspectorWidth: number;
}

interface WorkspaceLayoutState extends WorkspaceLayoutPreferences {
  mobilePanel: WorkspaceMobilePanel;
  setSessionRailCollapsed: (collapsed: boolean) => void;
  toggleSessionRail: () => void;
  setInspectorPinned: (pinned: boolean) => void;
  setInspectorWidth: (width: number) => void;
  setMobilePanel: (panel: WorkspaceMobilePanel) => void;
  resetLayout: () => void;
}

const DEFAULT_LAYOUT: WorkspaceLayoutPreferences = {
  sessionRailCollapsed: false,
  inspectorPinned: false,
  inspectorWidth: 320,
};

const serverStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

const clampInspectorWidth = (width: number): number =>
  Math.min(520, Math.max(280, Number.isFinite(width) ? width : DEFAULT_LAYOUT.inspectorWidth));

function persistedPreferences(
  state: WorkspaceLayoutState,
): WorkspaceLayoutPreferences {
  return {
    sessionRailCollapsed: state.sessionRailCollapsed,
    inspectorPinned: state.inspectorPinned,
    inspectorWidth: state.inspectorWidth,
  };
}

function mergePersistedLayout(
  persisted: unknown,
  current: WorkspaceLayoutState,
): WorkspaceLayoutState {
  if (!persisted || typeof persisted !== "object") return current;

  const value = persisted as Partial<WorkspaceLayoutPreferences>;
  return {
    ...current,
    sessionRailCollapsed:
      typeof value.sessionRailCollapsed === "boolean"
        ? value.sessionRailCollapsed
        : current.sessionRailCollapsed,
    inspectorPinned:
      typeof value.inspectorPinned === "boolean"
        ? value.inspectorPinned
        : current.inspectorPinned,
    inspectorWidth:
      typeof value.inspectorWidth === "number"
        ? clampInspectorWidth(value.inspectorWidth)
        : current.inspectorWidth,
    // Transient drawers intentionally never survive a reload.
    mobilePanel: null,
  };
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutState>()(
  persist(
    (set) => ({
      ...DEFAULT_LAYOUT,
      mobilePanel: null,
      setSessionRailCollapsed: (sessionRailCollapsed) =>
        set({ sessionRailCollapsed }),
      toggleSessionRail: () =>
        set((state) => ({
          sessionRailCollapsed: !state.sessionRailCollapsed,
        })),
      setInspectorPinned: (inspectorPinned) => set({ inspectorPinned }),
      setInspectorWidth: (inspectorWidth) =>
        set({ inspectorWidth: clampInspectorWidth(inspectorWidth) }),
      setMobilePanel: (mobilePanel) => set({ mobilePanel }),
      resetLayout: () => set({ ...DEFAULT_LAYOUT, mobilePanel: null }),
    }),
    {
      name: WORKSPACE_LAYOUT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        typeof window === "undefined" ? serverStorage : window.localStorage,
      ),
      partialize: persistedPreferences,
      merge: mergePersistedLayout,
      skipHydration: true,
    },
  ),
);

export const __testing = {
  clampInspectorWidth,
  defaultLayout: DEFAULT_LAYOUT,
  persistedPreferences,
};
