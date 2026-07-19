import { beforeEach, describe, expect, it } from "vitest";

import {
  __testing,
  useWorkspaceLayoutStore,
  WORKSPACE_LAYOUT_STORAGE_KEY,
} from "./workspace-layout-store";

describe("workspace layout store", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceLayoutStore.setState({
      ...__testing.defaultLayout,
      mobilePanel: null,
    });
    localStorage.clear();
  });

  it("persists only versioned layout preferences", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.setSessionRailCollapsed(true);
    store.setInspectorPinned(true);
    store.setInspectorWidth(476);
    store.setMobilePanel("navigation");

    const raw = localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? "{}")).toEqual({
      state: {
        sessionRailCollapsed: true,
        inspectorPinned: true,
        inspectorWidth: 476,
      },
      version: 1,
    });
  });

  it("keeps mobile panels ephemeral when preferences rehydrate", async () => {
    useWorkspaceLayoutStore.setState({
      ...__testing.defaultLayout,
      mobilePanel: "session",
    });
    localStorage.setItem(
      WORKSPACE_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        state: {
          sessionRailCollapsed: true,
          inspectorPinned: true,
          inspectorWidth: 410,
          mobilePanel: "inspector",
        },
        version: 1,
      }),
    );

    await useWorkspaceLayoutStore.persist.rehydrate();

    expect(useWorkspaceLayoutStore.getState()).toMatchObject({
      sessionRailCollapsed: true,
      inspectorPinned: true,
      inspectorWidth: 410,
      mobilePanel: null,
    });
  });

  it("clamps inspector width to the supported docking range", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.setInspectorWidth(120);
    expect(useWorkspaceLayoutStore.getState().inspectorWidth).toBe(280);

    store.setInspectorWidth(900);
    expect(useWorkspaceLayoutStore.getState().inspectorWidth).toBe(520);

    store.setInspectorWidth(Number.NaN);
    expect(useWorkspaceLayoutStore.getState().inspectorWidth).toBe(320);
  });

  it("toggles and resets the session rail without retaining a drawer", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.toggleSessionRail();
    store.setMobilePanel("inspector");
    expect(useWorkspaceLayoutStore.getState().sessionRailCollapsed).toBe(true);

    useWorkspaceLayoutStore.getState().resetLayout();
    expect(useWorkspaceLayoutStore.getState()).toMatchObject({
      ...__testing.defaultLayout,
      mobilePanel: null,
    });
  });
});
