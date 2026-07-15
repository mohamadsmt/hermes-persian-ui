import {cleanup, render, screen, waitFor, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {NextIntlClientProvider} from "next-intl";
import {afterEach, describe, expect, it, vi} from "vitest";

import en from "@/messages/en.json";

import type {LearningApi} from "./learning-api";
import {
  isSuccessfulPendingDecision,
  isValidSkillDiff,
  KnowledgePanel,
  type ExecuteLearningCommand,
} from "./knowledge-panel";

function api(): LearningApi {
  return {
    detail: vi.fn().mockResolvedValue({
      id: "timeline-1",
      kind: "memory",
      title: "Durable preference",
      body: "Use the profile-scoped source of truth.",
    }),
    pending: vi.fn().mockResolvedValue([
      {
        id: "memory-1",
        kind: "memory",
        title: "Remember profile boundary",
        operations: [{action: "replace", before: "all", after: "default"}],
      },
      {
        id: "skill-1",
        kind: "skill",
        title: "Safe deploy skill",
        operations: [],
      },
    ]),
    timeline: vi.fn().mockResolvedValue([
      {id: "timeline-1", kind: "memory", title: "Durable preference"},
    ]),
  };
}

function renderPanel({
  activeSessionId = "session-1",
  client = api(),
  executeCommand = vi.fn().mockResolvedValue({output: "# Pending skill write skill-1: safe deploy\n\ndiff --git a/SKILL.md b/SKILL.md"}),
}: {
  activeSessionId?: string | null;
  client?: LearningApi;
  executeCommand?: ExecuteLearningCommand;
} = {}) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <KnowledgePanel
        activeSessionId={activeSessionId}
        api={client}
        canReview
        executeCommand={executeCommand}
        profile="default"
      />
    </NextIntlClientProvider>,
  );
  return {client, executeCommand};
}

afterEach(cleanup);

describe("KnowledgePanel", () => {
  it("keeps long LTR timeline titles in a zero-basis flex track under RTL", async () => {
    const longTitle = "iran-gold-fx-market-analysis-with-a-long-unbroken-technical-name";
    const client = api();
    vi.mocked(client.timeline).mockResolvedValue([
      {id: "timeline-long", kind: "skill", title: longTitle},
    ]);

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <div dir="rtl">
          <KnowledgePanel
            activeSessionId="session-1"
            api={client}
            canReview
            executeCommand={vi.fn()}
            profile="default"
          />
        </div>
      </NextIntlClientProvider>,
    );

    const title = await screen.findByTestId("knowledge-timeline-title");
    const copyTrack = title.parentElement;
    const row = screen.getByTestId("knowledge-timeline-row");

    expect(title).toHaveTextContent(longTitle);
    expect(title).toHaveClass("w-full", "truncate");
    expect(copyTrack).toHaveClass(
      "min-w-0",
      "flex-1",
      "overflow-hidden",
      "rtl:w-0",
    );
    expect(row).toHaveClass("flex");
  });

  it("shows complete memory operations and remains read-only without a same-profile session", async () => {
    renderPanel({activeSessionId: null});
    const heading = await screen.findByRole("heading", {name: "Remember profile boundary"});
    const card = heading.closest("li");
    expect(card).not.toBeNull();
    expect(within(card!).getByText("all")).toBeInTheDocument();
    expect(within(card!).getByText("default")).toBeInTheDocument();
    expect(within(card!).getByRole("button", {name: "Approve"})).toBeDisabled();
    expect(screen.getByText(/Open a conversation in this profile/)).toBeInTheDocument();
  });

  it("requires a complete skill diff before approval and executes one slash command", async () => {
    const user = userEvent.setup();
    const executeCommand = vi.fn()
      .mockResolvedValueOnce({output: "# Pending skill write skill-1: safe deploy\n\ndiff --git a/SKILL.md b/SKILL.md"})
      .mockResolvedValueOnce({output: "Approved 1 skills write(s)."});
    renderPanel({executeCommand});
    const heading = await screen.findByRole("heading", {name: "Safe deploy skill"});
    const card = heading.closest("li");
    expect(card).not.toBeNull();
    const approve = within(card!).getByRole("button", {name: "Approve"});
    expect(approve).toBeDisabled();

    await user.click(within(card!).getByRole("button", {name: "Load skill diff"}));
    await waitFor(() => expect(executeCommand).toHaveBeenCalledWith("/skills diff skill-1"));
    expect(await within(card!).findByText(/diff --git/)).toBeInTheDocument();
    expect(approve).toBeEnabled();

    await user.click(approve);
    expect(screen.getByRole("alertdialog", {name: "Approve this pending write?"})).toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "Approve"}));
    await waitFor(() => expect(executeCommand).toHaveBeenCalledWith("/skills approve skill-1"));
    expect(executeCommand).toHaveBeenCalledTimes(2);
  });

  it("does not treat stale command text or partial mutation output as success", () => {
    expect(isValidSkillDiff("No pending skill write with id 'skill-1'.", "skill-1")).toBe(false);
    expect(isValidSkillDiff("# Pending skill write skill-1: title\n\nfull content", "skill-1")).toBe(true);
    expect(isSuccessfulPendingDecision(
      "Approved 0 skills write(s).\nFailed:\n skill-1: stale",
      "skill",
      "approve",
      "skill-1",
    )).toBe(false);
    expect(isSuccessfulPendingDecision(
      "Rejected pending memory write 'memory-1'.",
      "memory",
      "reject",
      "memory-1",
    )).toBe(true);
  });

  it("keeps skill approval disabled when the command reports a warning", async () => {
    const user = userEvent.setup();
    const executeCommand = vi.fn().mockResolvedValue({
      output: "# Pending skill write skill-1: safe deploy\n\ndiff --git a/SKILL.md b/SKILL.md",
      warning: "The command completed through a degraded fallback.",
    });
    renderPanel({executeCommand});
    const heading = await screen.findByRole("heading", {name: "Safe deploy skill"});
    const card = heading.closest("li");
    expect(card).not.toBeNull();

    await user.click(within(card!).getByRole("button", {name: "Load skill diff"}));

    expect(await within(card!).findByText(/complete diff is unavailable/i)).toBeInTheDocument();
    expect(within(card!).getByRole("button", {name: "Approve"})).toBeDisabled();
  });
});
