import { cleanup, render, screen } from "@testing-library/react";
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
});
