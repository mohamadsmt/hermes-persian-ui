import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatUiStore } from "@/store/chat-store";

import { PromptCard } from "./prompt-card";
import type { InteractivePrompt } from "./ui-types";

const labels = {
  approveOnce: "Approve once",
  approveAlways: "Always",
  deny: "Deny",
  submit: "Submit",
  cancel: "Cancel",
  expired: "Expired",
  secretPlaceholder: "Secret",
  sudoPlaceholder: "Password",
};

const approval: InteractivePrompt = {
  id: "approval:runtime-1",
  requestId: "approval:runtime-1",
  kind: "approval",
  title: "Run command?",
};

afterEach(cleanup);

describe("interactive prompts", () => {
  beforeEach(() => {
    useChatUiStore.setState({
      drafts: {},
      queuedPrompts: {},
      attachments: {},
      modelSettings: {},
      artifacts: {},
      selectedArtifactIds: {},
    });
    localStorage.clear();
  });

  it("focuses the safe approval default and prevents a double response", async () => {
    let finish: (() => void) | undefined;
    const onRespond = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<PromptCard prompt={approval} labels={labels} onRespond={onRespond} />);

    const deny = screen.getByTestId("approval-deny");
    expect(deny).toHaveFocus();
    await user.click(deny);
    fireEvent.click(deny);
    expect(onRespond).toHaveBeenCalledTimes(1);
    finish?.();
    await waitFor(() => expect(deny).not.toBeDisabled());
  });

  it("expires stale prompts without exposing actionable controls", () => {
    render(
      <PromptCard
        prompt={{ ...approval, expiresAt: new Date(Date.now() - 1_000).toISOString() }}
        labels={labels}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-approve")).not.toBeInTheDocument();
  });

  it("submits a secret from an uncontrolled input without persisting it", async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <PromptCard
        prompt={{ id: "secret-1", requestId: "secret-1", kind: "secret", title: "Token" }}
        labels={labels}
        onRespond={onRespond}
      />,
    );
    const value = "never-store-this-secret";
    await user.type(screen.getByPlaceholderText("Secret"), value);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({ kind: "secret" }), {
      action: "secret",
      value,
    });
    expect(JSON.stringify(useChatUiStore.getState())).not.toContain(value);
    expect(JSON.stringify(localStorage)).not.toContain(value);
  });
});
