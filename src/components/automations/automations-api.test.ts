import {describe, expect, it, vi} from "vitest";

import {AutomationsApiError, createAutomationsApi} from "./automations-api";

describe("automations api", () => {
  it("normalizes the official cron wire shape without exposing mutation routes beyond the allowlist", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jobs: [
            {
              id: "daily-review",
              profile: "default",
              name: "Daily review",
              schedule_display: "Every day at 09:00",
              enabled: false,
              last_run_at: 1_750_000_000,
            },
          ],
        }),
        {status: 200},
      ),
    );
    const api = createAutomationsApi(fetchMock as unknown as typeof fetch);

    await expect(api.list("default")).resolves.toEqual([
      expect.objectContaining({
        enabled: false,
        id: "daily-review",
        schedule: "Every day at 09:00",
        state: "paused",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hermes/automations?profile=default",
      expect.objectContaining({headers: {Accept: "application/json"}}),
    );
  });

  it("rejects aggregate profiles and command-injection identifiers before fetch", async () => {
    const fetchMock = vi.fn();
    const api = createAutomationsApi(fetchMock as unknown as typeof fetch);

    await expect(api.list("all")).rejects.toBeInstanceOf(AutomationsApiError);
    await expect(api.control("default", "job\n/delete", "run")).rejects.toBeInstanceOf(
      AutomationsApiError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads one bounded saved Markdown output through its detail route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      profile: "default",
      jobId: "daily-review",
      output: {
        id: "2026-07-15",
        name: "2026-07-15.md",
        content: "# Daily review",
        size: 14,
      },
    }), {status: 200}));
    const api = createAutomationsApi(fetchMock as unknown as typeof fetch);

    await expect(api.output("default", "daily-review", "2026-07-15")).resolves.toMatchObject({
      id: "2026-07-15",
      jobId: "daily-review",
      markdown: "# Daily review",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/hermes/automations/daily-review/outputs/2026-07-15?profile=default",
      expect.objectContaining({headers: {Accept: "application/json"}}),
    );
  });
});
