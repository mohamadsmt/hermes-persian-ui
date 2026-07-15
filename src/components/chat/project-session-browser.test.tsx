import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectTreePayload } from "@/lib/hermes";

import {
  buildProjectBrowserGroups,
  ProjectSessionBrowser,
} from "./project-session-browser";

afterEach(cleanup);

describe("ProjectSessionBrowser", () => {
  it("preserves the gateway project, repository, and lane hierarchy", async () => {
    const onSelectSession = vi.fn();
    const payload: ProjectTreePayload = {
      profile: "work",
      projects: [{
        id: "project-1",
        name: "Hermes UI",
        paths: ["/workspace/Hermes UI"],
        repositories: [{
          id: "repo-1",
          name: "hermes-ui",
          path: "/workspace/Hermes UI",
          lanes: [{
            id: "lane-main",
            name: "main",
            sessions: [{ id: "session-1", title: "Workspace implementation" }],
          }],
        }],
      }],
      scopedSessionIds: ["session-1"],
    };

    render(
      <ProjectSessionBrowser
        activeSessionId="session-1"
        locale="en"
        onSelectSession={onSelectSession}
        payload={payload}
      />,
    );

    expect(screen.getByText("Hermes UI")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    const session = screen.getByRole("button", { name: "Workspace implementation" });
    expect(session).toHaveAttribute("aria-current", "page");
    await userEvent.setup().click(session);
    expect(onSelectSession).toHaveBeenCalledWith("session-1");
  });

  it("falls back to safe repo/cwd grouping when no v4 tree is present", () => {
    const groups = buildProjectBrowserGroups(undefined, [
      { storedId: "one", title: "One", cwd: "/work/repo", gitRepoRoot: "/work/repo", lane: "feature" },
      { storedId: "two", title: "Two", cwd: "/work/repo/sub", gitRepoRoot: "/work/repo", lane: "feature" },
      { storedId: "three", title: "Three" },
    ]);

    expect(groups.map((group) => group.name)).toEqual(["repo", "Ungrouped"]);
    expect(groups[0]?.repositories[0]?.lanes[0]?.name).toBe("feature");
    expect(groups[0]?.repositories[0]?.lanes[0]?.sessions.map((session) => session.id)).toEqual(["one", "two"]);
  });
});
