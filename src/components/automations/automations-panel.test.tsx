import {cleanup, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {NextIntlClientProvider} from "next-intl";
import {afterEach, describe, expect, it, vi} from "vitest";

import en from "@/messages/en.json";

import type {AutomationJob, AutomationsApi} from "./automations-api";
import {AutomationsPanel} from "./automations-panel";

const jobs: AutomationJob[] = [
  {
    enabled: true,
    id: "active-job",
    name: "Active job",
    profile: "default",
    schedule: "Every hour",
    state: "idle",
  },
  {
    enabled: false,
    id: "paused-job",
    name: "Paused job",
    profile: "default",
    schedule: "Every day",
    state: "paused",
  },
];

function api(): AutomationsApi {
  return {
    control: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(jobs),
    outputs: vi.fn().mockResolvedValue([]),
    output: vi.fn().mockResolvedValue({id: "output", jobId: "active-job", name: "output.md"}),
    runs: vi.fn().mockResolvedValue([]),
  };
}

function renderPanel(client: AutomationsApi, canMutate = true) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AutomationsPanel api={client} canMutate={canMutate} profile="default" />
    </NextIntlClientProvider>,
  );
}

afterEach(cleanup);

describe("AutomationsPanel", () => {
  it("keeps a paused job from being run and exposes only resume", async () => {
    renderPanel(api());
    const paused = await screen.findByRole("heading", {name: "Paused job"});
    const card = paused.closest("article");
    expect(card).not.toBeNull();
    expect(screen.getAllByRole("button", {name: "Run"})[1]).toBeDisabled();
    expect(screen.getByRole("button", {name: "Resume"})).toBeEnabled();
  });

  it("confirms a run and reports it as queued instead of completed", async () => {
    const user = userEvent.setup();
    const client = api();
    renderPanel(client);
    await screen.findByRole("heading", {name: "Active job"});

    await user.click(screen.getAllByRole("button", {name: "Run"})[0]);
    expect(screen.getByRole("alertdialog", {name: "Queue this automation?"})).toBeInTheDocument();
    expect(client.control).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", {name: "Confirm"}));

    await waitFor(() => expect(client.control).toHaveBeenCalledWith("default", "active-job", "run"));
    expect(await screen.findAllByText(/Queued for the next scheduler tick/)).toHaveLength(2);
  });

  it("disables every mutation on a read-only connection", async () => {
    renderPanel(api(), false);
    await screen.findByRole("heading", {name: "Active job"});
    for (const button of screen.getAllByRole("button", {name: "Run"})) {
      expect(button).toBeDisabled();
    }
    expect(screen.getByRole("button", {name: "Pause"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "Resume"})).toBeDisabled();
  });

  it("loads saved Markdown lazily without dropping its safe download link", async () => {
    const user = userEvent.setup();
    const client = api();
    vi.mocked(client.outputs).mockResolvedValue([{
      downloadUrl: "/api/hermes/automations/active-job/outputs/output/download?profile=default",
      id: "output",
      jobId: "active-job",
      name: "output.md",
    }]);
    vi.mocked(client.output).mockResolvedValue({
      id: "output",
      jobId: "active-job",
      markdown: "# Safe output",
      name: "output.md",
    });
    renderPanel(client);
    await screen.findByRole("heading", {name: "Active job"});

    await user.click(screen.getAllByRole("button", {name: "Details"})[0]);
    await user.click(await screen.findByRole("button", {name: "View output"}));

    expect(await screen.findByText("# Safe output")).toBeInTheDocument();
    expect(screen.getByRole("link", {name: "Download"})).toHaveAttribute(
      "href",
      "/api/hermes/automations/active-job/outputs/output/download?profile=default",
    );
  });
});
