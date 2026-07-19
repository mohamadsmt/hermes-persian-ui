import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRail } from "./session-rail";
import type { SessionSummary } from "./ui-types";

const labels = {
  title: "Conversations",
  newSession: "New",
  search: "Search",
  empty: "Empty",
  noResults: "No results",
  rename: "Rename",
  delete: "Delete",
  close: "Close conversation",
  usage: "Usage",
  cancel: "Cancel",
  confirmDelete: "Delete?",
  confirmClose: "Close this conversation?",
  closeDescription: "History stays available.",
  renameTitle: "Rename conversation",
  statusNeedsInput: "Needs your response",
  statusError: "Conversation has an error",
  statusStarting: "Conversation is starting",
  statusWorking: "Conversation is working",
  statusUnread: "Conversation completed with unread updates",
  statusIdle: "Conversation is ready",
  collapse: "Collapse sidebar",
  expand: "Expand sidebar",
};

const sessions = [
  { storedId: "active", title: "Active", status: "active", messageCount: 2 },
  { storedId: "idle", title: "Idle", status: "idle", messageCount: 1 },
];

afterEach(cleanup);

describe("session capability controls", () => {
  it("renders a selectable icon rail and exposes a controlled collapse toggle", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onToggleCollapsed = vi.fn();
    render(
      <SessionRail
        sessions={sessions}
        activeSessionId="active"
        locale="en"
        labels={labels}
        collapsed
        onToggleCollapsed={onToggleCollapsed}
        onCreate={vi.fn()}
        onSelect={onSelect}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByTestId("session-list")).toHaveAttribute("data-collapsed", "true");
    expect(screen.queryByTestId("session-search")).not.toBeInTheDocument();
    expect(screen.getByTestId("new-session")).toHaveAccessibleName("New");
    expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "Idle" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ storedId: "idle" }));
    await user.click(screen.getByTestId("session-rail-toggle"));
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });

  it("renders the highest-priority state with a distinct accessible indicator", () => {
    const stateSessions: SessionSummary[] = [
      {
        storedId: "attention",
        title: "Attention",
        live: true,
        runtimeStatus: "working",
        needsInput: true,
        error: "also failed",
        unread: true,
      },
      {
        storedId: "error",
        title: "Error",
        live: true,
        runtimeStatus: "working",
        error: "failed",
        unread: true,
      },
      {
        storedId: "starting",
        title: "Starting",
        live: true,
        runtimeStatus: "starting",
        unread: true,
      },
      {
        storedId: "working",
        title: "Working",
        live: true,
        runtimeStatus: "working",
        unread: true,
      },
      {
        storedId: "unread",
        title: "Unread",
        live: true,
        runtimeStatus: "idle",
        unread: true,
      },
      {
        storedId: "idle",
        title: "Idle",
        live: true,
        runtimeStatus: "idle",
      },
      { storedId: "history", title: "History", live: false },
    ];
    render(
      <SessionRail
        sessions={stateSessions}
        locale="en"
        labels={labels}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    const row = (id: string) => screen.getAllByTestId("session-item").find(
      (item) => item.getAttribute("data-session-id") === id,
    )!;
    const expectStatus = (id: string, name: string, kind: string) => {
      const indicator = within(row(id)).getByRole("img", { name });
      expect(indicator).toHaveAttribute("data-session-status", kind);
      expect(indicator).toHaveAttribute("title", name);
      expect(indicator.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    };

    expectStatus("attention", labels.statusNeedsInput, "needs-input");
    expectStatus("error", labels.statusError, "error");
    expectStatus("starting", labels.statusStarting, "starting");
    expectStatus("working", labels.statusWorking, "working");
    expectStatus("unread", labels.statusUnread, "unread");
    expectStatus("idle", labels.statusIdle, "idle");
    expect(within(row("history")).queryByTestId("session-status-indicator")).not.toBeInTheDocument();
  });

  it("prevents deleting a non-selected live conversation while preserving other actions", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const actionSessions: SessionSummary[] = [
      { storedId: "selected-live", title: "Selected live", live: true, runtimeStatus: "working" },
      { storedId: "background-live", title: "Background live", live: true, runtimeStatus: "working" },
      { storedId: "historical", title: "Historical", live: false },
      { storedId: "legacy-live", title: "Legacy live", status: "active" },
    ];
    render(
      <SessionRail
        sessions={actionSessions}
        activeSessionId="selected-live"
        locale="en"
        labels={labels}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const row = (id: string) => screen.getAllByTestId("session-item").find(
      (item) => item.getAttribute("data-session-id") === id,
    )!;

    await user.click(within(row("selected-live")).getByTestId("session-actions"));
    await user.click(within(row("selected-live")).getByTestId("delete-session"));
    await user.click(screen.getByTestId("confirm-delete"));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ storedId: "selected-live" }));

    await user.click(within(row("background-live")).getByTestId("session-actions"));
    expect(within(row("background-live")).getByTestId("rename-session")).toBeInTheDocument();
    expect(within(row("background-live")).queryByTestId("delete-session")).not.toBeInTheDocument();
    await user.click(within(row("background-live")).getByTestId("session-actions"));

    await user.click(within(row("legacy-live")).getByTestId("session-actions"));
    expect(within(row("legacy-live")).queryByTestId("delete-session")).not.toBeInTheDocument();
    await user.click(within(row("legacy-live")).getByTestId("session-actions"));

    await user.click(within(row("historical")).getByTestId("session-actions"));
    expect(within(row("historical")).getByTestId("delete-session")).toBeInTheDocument();
  });

  it("offers usage and confirmed close only for the live active session", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn().mockResolvedValue(undefined);
    const onUsage = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionRail
        sessions={sessions}
        activeSessionId="active"
        locale="en"
        labels={labels}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onClose={onClose}
        onUsage={onUsage}
      />,
    );

    await user.click(screen.getAllByTestId("session-actions")[0]);
    await user.click(screen.getByTestId("session-usage"));
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ storedId: "active" }));

    await user.click(screen.getAllByTestId("session-actions")[0]);
    await user.click(screen.getByTestId("close-session"));
    expect(screen.getByRole("alertdialog", { name: "Close this conversation?" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("confirm-close"));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ storedId: "active" }));

    await user.click(screen.getAllByTestId("session-actions")[1]);
    expect(screen.queryByTestId("session-usage")).not.toBeInTheDocument();
    expect(screen.queryByTestId("close-session")).not.toBeInTheDocument();
  });

  it("disables creation when the negotiated transport has no gateway sessions", () => {
    render(
      <SessionRail
        sessions={[]}
        locale="en"
        labels={labels}
        canCreate={false}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByTestId("new-session")).toBeDisabled();
  });

  it("keeps project-scoped sessions out of flat recents while preserving local search", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn().mockResolvedValue(undefined);
    const onUsage = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionRail
        sessions={sessions}
        activeSessionId="active"
        locale="en"
        labels={labels}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onClose={onClose}
        onUsage={onUsage}
        projectBrowser={<div>Structured project session</div>}
        projectRecentSessions={[sessions[1]!]}
      />,
    );

    expect(screen.getByTestId("session-projects")).toHaveTextContent("Structured project session");
    const management = screen.getByTestId("project-session-management");
    expect(management).not.toHaveAttribute("open");
    expect(within(management).getByTestId("session-item")).toHaveAttribute("data-session-id", "active");
    const visibleRecents = screen.getAllByTestId("session-item").filter((row) => !management.contains(row));
    expect(visibleRecents).toHaveLength(1);
    expect(visibleRecents[0]).toHaveAttribute("data-session-id", "idle");
    expect(screen.getByText("Recent conversations")).toBeInTheDocument();

    await user.click(within(management).getByText("Manage conversations"));
    expect(management).toHaveAttribute("open");
    await user.click(within(management).getByTestId("session-actions"));
    expect(within(management).getByTestId("session-usage")).toBeInTheDocument();
    expect(within(management).getByTestId("close-session")).toBeInTheDocument();
    expect(within(management).getByTestId("rename-session")).toBeInTheDocument();
    expect(within(management).getByTestId("delete-session")).toBeInTheDocument();

    await user.type(screen.getByTestId("session-search"), "Active");
    expect(screen.queryByTestId("session-projects")).not.toBeInTheDocument();
    expect(management).toHaveAttribute("hidden");
    expect(management).toHaveAttribute("open");
    const searchRows = screen.getAllByTestId("session-item").filter((row) => !management.contains(row));
    expect(searchRows).toHaveLength(1);
    expect(searchRows[0]).toHaveAttribute("data-session-id", "active");
  });

  it("keeps the fallback rail hidden until the v4 project tree finishes hydrating", () => {
    const common = {
      sessions,
      locale: "en",
      labels,
      onCreate: vi.fn(),
      onSelect: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      projectRecentSessions: [] as typeof sessions,
    };
    const {rerender} = render(
      <SessionRail
        {...common}
        loading
        projectBrowser={<div>Premature fallback grouping</div>}
      />,
    );

    expect(screen.queryByText("Premature fallback grouping")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-projects")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".session-skeleton")).toHaveLength(5);

    rerender(
      <SessionRail
        {...common}
        loading={false}
        projectBrowser={<div>Hydrated v4 project tree</div>}
      />,
    );

    expect(screen.getByTestId("session-projects")).toHaveTextContent("Hydrated v4 project tree");
    expect(screen.queryByText("Premature fallback grouping")).not.toBeInTheDocument();
    expect(screen.getByTestId("project-session-management")).not.toHaveAttribute("open");
  });
});
