import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionRail } from "./session-rail";

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
};

const sessions = [
  { storedId: "active", title: "Active", status: "active", messageCount: 2 },
  { storedId: "idle", title: "Idle", status: "idle", messageCount: 1 },
];

afterEach(cleanup);

describe("session capability controls", () => {
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
