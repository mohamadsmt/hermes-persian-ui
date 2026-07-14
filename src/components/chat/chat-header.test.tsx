import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatHeader } from "./chat-header";
import { REASONING_EFFORTS, type SessionModelSettings } from "./ui-types";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }),
}));

const labels = {
  appName: "Hermes",
  openSessions: "Open sessions",
  openWorkspace: "Open workspace",
  settings: "Settings",
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  unavailable: "Unavailable",
  model: "Model",
  profile: "Profile",
  reasoning: "Reasoning effort",
  fastMode: "Fast mode",
  theme: "Theme",
  branch: "Branch",
  compress: "Compress",
};

const models = [
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    providerName: "OpenAI",
    current: true,
    authenticated: true,
    supportsReasoning: true,
  },
];

function renderHeader(
  modelSettings: SessionModelSettings,
  onReasoningChange = vi.fn(),
) {
  return render(
    <ChatHeader
      locale="en"
      title="Conversation"
      connection="connected"
      models={models}
      modelSettings={modelSettings}
      profiles={["default"]}
      activeProfile="default"
      capabilities={{
        gateway: true,
        sessions: true,
        models: true,
        attachments: true,
        approvals: true,
        clarification: true,
        sudo: true,
        secrets: true,
        branch: true,
        compress: true,
        voice: true,
        httpFallback: false,
      }}
      labels={labels}
      onOpenSessions={vi.fn()}
      onOpenArtifacts={vi.fn()}
      onModelChange={vi.fn()}
      onProfileChange={vi.fn()}
      onReasoningChange={onReasoningChange}
      onBranch={vi.fn()}
      onCompress={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("ChatHeader reasoning picker", () => {
  it("shows every Hermes reasoning effort and selects Ultra", () => {
    renderHeader({ model: "gpt-5.6-sol", provider: "openai", reasoning: "ultra" });

    const picker = screen.getByTestId("reasoning-picker");
    expect(picker).toHaveValue("ultra");
    expect(picker).toBeEnabled();
    expect(
      within(picker).getAllByRole("option").map((option) => option.getAttribute("value")),
    ).toEqual([...REASONING_EFFORTS]);
  });

  it("preserves session overrides when the active session changes", () => {
    const { rerender } = renderHeader({
      model: "gpt-5.6-sol",
      provider: "openai",
      reasoning: "ultra",
    });

    const props = {
      locale: "en",
      title: "Conversation",
      connection: "connected" as const,
      models,
      profiles: ["default"],
      activeProfile: "default",
      labels,
      onOpenSessions: vi.fn(),
      onOpenArtifacts: vi.fn(),
      onModelChange: vi.fn(),
      onProfileChange: vi.fn(),
      onReasoningChange: vi.fn(),
      onBranch: vi.fn(),
      onCompress: vi.fn(),
    };

    rerender(
      <ChatHeader
        {...props}
        modelSettings={{
          model: "gpt-5.6-sol",
          provider: "openai",
          reasoning: "high",
        }}
      />,
    );
    expect(screen.getByTestId("reasoning-picker")).toHaveValue("high");

    rerender(
      <ChatHeader
        {...props}
        modelSettings={{
          model: "gpt-5.6-sol",
          provider: "openai",
          reasoning: "none",
        }}
      />,
    );
    expect(screen.getByTestId("reasoning-picker")).toHaveValue("none");
    expect(screen.getByTestId("reasoning-picker")).toBeEnabled();
  });

  it("renders a future Hermes value verbatim instead of falling back to Low", () => {
    renderHeader({
      model: "gpt-5.6-sol",
      provider: "openai",
      reasoning: "adaptive-v2",
    });

    const picker = screen.getByTestId("reasoning-picker");
    expect(picker).toHaveValue("adaptive-v2");
    const futureOption = within(picker).getByRole("option", { name: "adaptive-v2" });
    expect(futureOption).toBeInTheDocument();
    expect((futureOption as HTMLOptionElement).selected).toBe(true);
  });

  it("is neutral and disabled without an authoritative session value", () => {
    renderHeader({ model: "gpt-5.6-sol", provider: "openai" });

    const picker = screen.getByTestId("reasoning-picker");
    expect(picker).toHaveValue("");
    expect(picker).toBeDisabled();
    const neutralOption = within(picker).getByRole("option", { name: "—" });
    expect((neutralOption as HTMLOptionElement).selected).toBe(true);
  });

  it("sends the selected value through the session-scoped callback", async () => {
    const user = userEvent.setup();
    const onReasoningChange = vi.fn().mockResolvedValue(undefined);
    renderHeader(
      { model: "gpt-5.6-sol", provider: "openai", reasoning: "ultra" },
      onReasoningChange,
    );

    await user.selectOptions(screen.getByTestId("reasoning-picker"), "minimal");
    expect(onReasoningChange).toHaveBeenCalledOnce();
    expect(onReasoningChange).toHaveBeenCalledWith("minimal");
  });
});
