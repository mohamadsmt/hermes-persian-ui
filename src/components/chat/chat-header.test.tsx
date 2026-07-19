import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatHeader } from "./chat-header";

const setTheme = vi.fn();
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme }),
}));

const labels = {
  openSessions: "Open sessions",
  openWorkspace: "Open workspace",
  settings: "Settings",
  connected: "Connected",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  unavailable: "Unavailable",
  theme: "Theme",
  branch: "Branch",
  compress: "Compress",
  recovery: "Recovery",
  more: "More actions",
  pinInspector: "Pin inspector",
  unpinInspector: "Unpin inspector",
};

function renderHeader(overrides: Partial<React.ComponentProps<typeof ChatHeader>> = {}) {
  const props: React.ComponentProps<typeof ChatHeader> = {
    locale: "en",
    title: "Conversation",
    connection: "connected",
    capabilities: {
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
    },
    labels,
    onOpenSessions: vi.fn(),
    onOpenArtifacts: vi.fn(),
    onBranch: vi.fn(),
    onCompress: vi.fn(),
    onRecovery: vi.fn(),
    onToggleInspectorPin: vi.fn(),
    ...overrides,
  };
  render(<ChatHeader {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("compact ChatHeader", () => {
  it("keeps the primary row focused on title, status, and panel triggers", () => {
    renderHeader();

    expect(screen.getByRole("heading", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.getByTestId("connection-status")).toHaveTextContent("Connected");
    expect(screen.getByRole("button", { name: "Open sessions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open workspace" })).toBeInTheDocument();
    expect(screen.queryByTestId("model-picker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reasoning-picker")).not.toBeInTheDocument();
  });

  it("moves branch, compress, recovery, theme, settings, and pinning into overflow", async () => {
    const user = userEvent.setup();
    const props = renderHeader();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("header-more-trigger"));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("Branch");
    expect(menu).toHaveTextContent("Compress");
    expect(menu).toHaveTextContent("Recovery");
    expect(menu).toHaveTextContent("Theme");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveAttribute("href", "/en/settings");

    await user.click(screen.getByRole("menuitem", { name: "Branch" }));
    expect(props.onBranch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("header-more-trigger"));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Pin inspector" }));
    expect(props.onToggleInspectorPin).toHaveBeenCalledOnce();
  });

  it("closes overflow with Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderHeader();
    const trigger = screen.getByTestId("header-more-trigger");
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await vi.waitFor(() => expect(trigger).toHaveFocus());
  });
});
