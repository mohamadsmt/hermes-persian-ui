import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectTreePayload } from "@/lib/hermes";

import {
  buildProjectBrowserGroups,
  ProjectSessionBrowser,
  sessionsOutsideRenderedProjects,
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
    expect(screen.getByTestId("project-session-project-title").parentElement).toHaveClass(
      "min-w-0",
      "flex-1",
      "overflow-hidden",
      "w-0",
    );
    expect(screen.getByTestId("project-session-title").parentElement).toHaveClass(
      "min-w-0",
      "flex-1",
      "overflow-hidden",
      "w-0",
    );
    expect(screen.getByTestId("project-browser")).toHaveClass(
      "min-w-0",
      "grid-cols-[minmax(0,1fr)]",
      "overflow-hidden",
    );
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

  it("hydrates a flat drill-in response into its sole repository without an empty duplicate", () => {
    const groups = buildProjectBrowserGroups({
      profile: "work",
      projects: [{
        id: "project-1",
        name: "Hermes UI",
        paths: ["/workspace/Hermes UI"],
        repositories: [{
          id: "repo-1",
          name: "Hermes UI",
          path: "/workspace/Hermes UI",
          lanes: [],
        }],
        sessions: [{id: "session-1", title: "Workspace implementation"}],
      }],
      scopedSessionIds: ["session-1"],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.repositories).toHaveLength(1);
    expect(groups[0]?.repositories[0]?.lanes).toEqual([{
      id: "project-1:direct:sessions",
      name: "Sessions",
      sessions: [{id: "session-1", title: "Workspace implementation"}],
    }]);
  });

  it("omits v4 project cards that have no hydrated or preview sessions", () => {
    const groups = buildProjectBrowserGroups({
      profile: "default",
      projects: [
        {
          id: "empty",
          name: "Empty project",
          paths: ["/workspace/empty"],
          repositories: [{
            id: "empty-repo",
            name: "empty",
            lanes: [{id: "empty-lane", name: "main", sessions: []}],
          }],
        },
        {
          id: "active",
          name: "Active project",
          paths: ["/workspace/active"],
          repositories: [{
            id: "active-repo",
            name: "active",
            lanes: [{
              id: "active-lane",
              name: "main",
              sessions: [{id: "session-1", title: "Visible session"}],
            }],
          }],
        },
      ],
      scopedSessionIds: ["session-1"],
    });

    expect(groups.map((group) => group.id)).toEqual(["active"]);
  });

  it("keeps sessions missing from a failed drill-in visible in recents", () => {
    const payload: ProjectTreePayload = {
      profile: "default",
      projects: [{
        id: "project-1",
        name: "Hermes UI",
        paths: ["/workspace/Hermes UI"],
        sessions: [{id: "preview", title: "Rendered preview"}],
      }],
      // The gateway still scopes every owned session even when drill-in fails.
      scopedSessionIds: ["preview", "not-hydrated"],
    };

    expect(sessionsOutsideRenderedProjects(payload, [
      {storedId: "preview", title: "Rendered preview"},
      {storedId: "not-hydrated", title: "Still visible"},
    ]).map((session) => session.storedId)).toEqual(["not-hydrated"]);
  });
});
