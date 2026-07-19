import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity, MessageSquare } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useWorkspaceLayoutStore } from "@/store/workspace-layout-store";

import { WorkspaceNavigation } from "./workspace-navigation";

const items = [
  {
    active: true,
    href: "/en",
    icon: MessageSquare,
    key: "chat",
    label: "Chat",
  },
  {
    active: false,
    href: "/en/activity",
    icon: Activity,
    key: "activity",
    label: "Activity",
  },
] as const;

function renderNavigation() {
  return render(
    <WorkspaceNavigation
      closeLabel="Close navigation"
      items={items}
      menuLabel="Navigation"
      openLabel="Open navigation"
      workspaceLabel="Hermes workspace"
    />,
  );
}

describe("WorkspaceNavigation", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    useWorkspaceLayoutStore.setState({ mobilePanel: null });
  });

  it("exposes an icon rail with accessible names and tooltips", () => {
    renderNavigation();

    expect(screen.getByRole("navigation", { name: "Hermes workspace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute("title", "Chat");
    expect(screen.getByRole("link", { name: "Chat" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Activity" })).not.toHaveAttribute("aria-current");
  });

  it("opens as a compact dialog and restores focus on Escape", async () => {
    const user = userEvent.setup();
    renderNavigation();
    const trigger = screen.getByRole("button", { name: "Open navigation" });

    await user.click(trigger);

    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
    expect(useWorkspaceLayoutStore.getState().mobilePanel).toBe("navigation");
    expect(screen.getByRole("link", { name: "Chat" })).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(useWorkspaceLayoutStore.getState().mobilePanel).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("traps forward and reverse focus while the drawer is open", async () => {
    const user = userEvent.setup();
    renderNavigation();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));

    const closeButtons = screen.getAllByRole("button", { name: "Close navigation" });
    const closeButton = closeButtons.find((button) => button.getAttribute("tabindex") !== "-1");
    const lastLink = screen.getByRole("link", { name: "Activity" });
    expect(closeButton).toBeDefined();

    closeButton?.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(lastLink).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();
  });
});
