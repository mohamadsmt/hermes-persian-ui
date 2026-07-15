import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionSearchHit } from "@/lib/hermes";

import { SessionRail } from "./session-rail";
import {
  MAX_SESSION_SEARCH_QUERY,
  dedupeSessionSearchHits,
  normalizeSessionSearchQuery,
} from "./session-search";

const labels = {
  title: "Conversations",
  newSession: "New",
  search: "Search",
  empty: "Empty",
  noResults: "No results",
  rename: "Rename",
  delete: "Delete",
  close: "Close",
  usage: "Usage",
  cancel: "Cancel",
  confirmDelete: "Delete?",
  confirmClose: "Close?",
  closeDescription: "History remains available.",
  renameTitle: "Rename",
  messageMatch: "Matches in messages",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("session FTS search", () => {
  it("normalizes the query and deduplicates a lineage", () => {
    expect(normalizeSessionSearchQuery(`  ${"x".repeat(300)}  `)).toHaveLength(MAX_SESSION_SEARCH_QUERY);
    const hits: SessionSearchHit[] = [
      { profile: "work", sessionId: "resume-1", lineageRoot: "root", snippet: "first" },
      { profile: "work", sessionId: "resume-2", lineageRoot: "root", snippet: "second" },
      { profile: "work", sessionId: "other", snippet: "third" },
    ];
    expect(dedupeSessionSearchHits(hits).map((hit) => hit.sessionId)).toEqual(["resume-1", "other"]);
  });

  it("runs a profile-scoped search and renders snippets as text", async () => {
    const user = userEvent.setup();
    const onSelectSearchResult = vi.fn();
    const onSearchCapabilityChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      profile: "work",
      query: "needle",
      results: [
        {
          profile: "work",
          sessionId: "resume-1",
          lineageRoot: "root-1",
          snippet: "<mark>needle</mark> in a message",
          role: "user",
          model: "gpt-test",
        },
        {
          profile: "work",
          sessionId: "resume-2",
          lineageRoot: "root-1",
          snippet: "duplicate lineage",
        },
      ],
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SessionRail
        labels={labels}
        locale="en"
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onSelect={vi.fn()}
        onSelectSearchResult={onSelectSearchResult}
        onSearchCapabilityChange={onSearchCapabilityChange}
        searchDebounceMs={0}
        searchProfile="work"
        sessions={[]}
      />,
    );

    fireEvent.change(screen.getByTestId("session-search"), { target: { value: "needle" } });
    const result = await screen.findByTestId("session-search-result");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onSearchCapabilityChange).toHaveBeenCalledWith("available");
    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(requestUrl.searchParams.get("profile")).toBe("work");
    expect(requestUrl.searchParams.get("q")).toBe("needle");
    expect(requestUrl.searchParams.get("limit")).toBe("50");
    expect(screen.getAllByTestId("session-search-result")).toHaveLength(1);
    expect(result).toHaveTextContent("<mark>needle</mark> in a message");
    expect(result.querySelector("mark")).toBeNull();

    await user.click(result);
    expect(onSelectSearchResult).toHaveBeenCalledWith(expect.objectContaining({
      profile: "work",
      sessionId: "resume-1",
    }));
  });

  it("disables only remote search when its endpoint is unsupported", async () => {
    const onSearchCapabilityChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {status: 404})));

    render(
      <SessionRail
        labels={labels}
        locale="en"
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onSearchCapabilityChange={onSearchCapabilityChange}
        onSelect={vi.fn()}
        onSelectSearchResult={vi.fn()}
        searchDebounceMs={0}
        searchProfile="work"
        sessions={[]}
      />,
    );

    fireEvent.change(screen.getByTestId("session-search"), {target: {value: "needle"}});
    await waitFor(() => expect(onSearchCapabilityChange).toHaveBeenCalledWith("unavailable"));
  });

  it("does not display a response from a mismatched profile", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      profile: "other",
      query: "needle",
      results: [{ profile: "other", sessionId: "session", snippet: "secret" }],
    }), { headers: { "content-type": "application/json" }, status: 200 })));

    render(
      <SessionRail
        labels={labels}
        locale="en"
        onCreate={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        onSelect={vi.fn()}
        onSelectSearchResult={vi.fn()}
        searchDebounceMs={0}
        searchProfile="work"
        sessions={[]}
      />,
    );

    fireEvent.change(screen.getByTestId("session-search"), { target: { value: "needle" } });
    await waitFor(() => expect(screen.getByText("Message search is unavailable.")).toBeInTheDocument());
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
  });
});
