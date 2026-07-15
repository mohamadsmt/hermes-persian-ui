import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildNewSessionSubmission,
  NewSessionDialog,
} from "./new-session-dialog";

const models = [{
  id: "gpt-test",
  provider: "openai",
  providerName: "OpenAI",
  current: false,
  authenticated: true,
  supportsFast: true,
  supportsReasoning: true,
}];

afterEach(cleanup);

describe("NewSessionDialog", () => {
  it("omits profile defaults and preserves an explicit fast-off override", () => {
    expect(buildNewSessionSubmission({
      cwd: " ",
      fast: "default",
      model: "",
      profile: " work ",
      projectId: "",
      provider: "",
      reasoning: "",
    })).toEqual({ profile: "work" });

    expect(buildNewSessionSubmission({
      cwd: "",
      fast: "off",
      model: "",
      profile: "work",
      projectId: "",
      provider: "",
      reasoning: "",
    })).toEqual({ profile: "work", fast: false });
  });

  it("validates CWD and submits only the selected creation overrides", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onValidateCwd = vi.fn().mockResolvedValue({
      valid: true,
      canonicalPath: "/canonical/hermes-ui",
    });
    render(
      <NewSessionDialog
        locale="en"
        models={models}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onValidateCwd={onValidateCwd}
        open
        profiles={["work", "personal"]}
        projects={[{ id: "hermes", name: "Hermes UI", cwd: "/work/hermes-ui" }]}
      />,
    );

    await user.selectOptions(screen.getByTestId("new-session-project"), "hermes");
    await user.selectOptions(screen.getByTestId("new-session-model"), "0");
    await user.selectOptions(screen.getByTestId("new-session-reasoning"), "high");
    await user.selectOptions(screen.getByTestId("new-session-fast"), "on");
    await user.click(screen.getByRole("button", { name: "Create conversation" }));

    expect(onValidateCwd).toHaveBeenCalledWith("work", "/work/hermes-ui");
    expect(onSubmit).toHaveBeenCalledWith({
      profile: "work",
      projectId: "hermes",
      cwd: "/canonical/hermes-ui",
      model: "gpt-test",
      provider: "openai",
      reasoningEffort: "high",
      fast: true,
    });
  });

  it("never submits or silently replaces an invalid CWD", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <NewSessionDialog
        defaultCwd="/missing"
        locale="en"
        models={[]}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        onValidateCwd={vi.fn().mockResolvedValue({ valid: false, error: "Directory does not exist" })}
        open
        profiles={["work"]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Create conversation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Directory does not exist");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-session-cwd")).toHaveValue("/missing");
  });
});
