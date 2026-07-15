import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  safeWorkspaceRelativePath,
  WorkspaceFilesRail,
  workspaceDownloadUrl,
} from "./workspace-files-rail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkspaceFilesRail", () => {
  it("rejects absolute paths, traversal, and backslash ambiguity", () => {
    expect(safeWorkspaceRelativePath("src/app.ts")).toBe("src/app.ts");
    expect(safeWorkspaceRelativePath("../secret")).toBeNull();
    expect(safeWorkspaceRelativePath("/etc/passwd")).toBeNull();
    expect(safeWorkspaceRelativePath("C:\\secret")).toBeNull();
    expect(safeWorkspaceRelativePath("src\\secret")).toBeNull();
    expect(workspaceDownloadUrl("work", "session", "../secret")).toBeNull();
    expect(workspaceDownloadUrl("all", "session", "readme.md")).toBeNull();
  });

  it("lists, previews, downloads, and attaches read-only workspace files", async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn().mockResolvedValue(undefined);
    const onCapabilityChange = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      expect(url.searchParams.get("profile")).toBe("work");
      expect(url.searchParams.get("sessionId")).toBe("session-1");
      if (url.pathname.endsWith("/validate")) {
        return Promise.resolve(jsonResponse({
          profile: "work",
          sessionId: "session-1",
          cwdAvailable: true,
          root: { name: "Hermes UI" },
        }));
      }
      if (url.pathname.endsWith("/list")) {
        return Promise.resolve(jsonResponse({
          profile: "work",
          sessionId: "session-1",
          path: "",
          parent: null,
          entries: [
            { name: "src", path: "src", isDirectory: true },
            { name: "README.md", path: "README.md", isDirectory: false, size: 24, modifiedAt: 1_700_000_000, mimeType: "text/markdown", previewable: true },
          ],
        }));
      }
      if (url.pathname.endsWith("/read")) {
        return Promise.resolve(jsonResponse({
          profile: "work",
          sessionId: "session-1",
          file: {
            name: "README.md",
            path: "README.md",
            isDirectory: false,
            size: 24,
            mimeType: "text/markdown",
            previewable: true,
            kind: "text",
            content: "# Hermes Workspace",
          },
        }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <WorkspaceFilesRail
        locale="en"
        onAttach={onAttach}
        onCapabilityChange={onCapabilityChange}
        onClose={vi.fn()}
        open
        profile="work"
        sessionId="session-1"
      />,
    );

    expect(await screen.findByText("README.md")).toBeInTheDocument();
    expect(onCapabilityChange).toHaveBeenCalledWith("validate", "available");
    expect(onCapabilityChange).toHaveBeenCalledWith("list", "available");
    expect(screen.getByText("Hermes UI")).toBeInTheDocument();
    await user.click(screen.getByText("README.md"));
    expect(await screen.findByText("# Hermes Workspace")).toBeInTheDocument();
    expect(onCapabilityChange).toHaveBeenCalledWith("read", "available");

    const download = screen.getByRole("link", { name: "Download file" });
    const downloadUrl = new URL(download.getAttribute("href") ?? "", "http://localhost");
    expect(downloadUrl.pathname).toBe("/api/hermes/workspace/download");
    expect(downloadUrl.searchParams.get("path")).toBe("README.md");

    await user.click(screen.getByRole("button", { name: "Attach to conversation" }));
    await waitFor(() => expect(onAttach).toHaveBeenCalledWith(expect.objectContaining({
      name: "README.md",
      path: "README.md",
    })));
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("upload") && !String(input).includes("delete"))).toBe(true);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
