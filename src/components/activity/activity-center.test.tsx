import {cleanup, render, screen} from "@testing-library/react";
import {NextIntlClientProvider} from "next-intl";
import {afterEach, describe, expect, it} from "vitest";

import en from "@/messages/en.json";

import {ActivityCenter} from "./activity-center";
import {activityReducer, createActivityState} from "./activity-reducer";

afterEach(cleanup);

describe("ActivityCenter", () => {
  it("labels unowned activity as runtime-wide and verification as recorded evidence", () => {
    let activity = activityReducer(createActivityState("default"), {
      type: "hydrate",
      sessionId: "session-1",
      snapshot: {
        verification: {
          status: "complete",
          summary: "All focused tests passed.",
          updatedAt: 10,
        },
      },
    });
    activity = activityReducer(activity, {
      type: "hydrate",
      snapshot: {
        backgroundCompletions: [
          {
            completedAt: 20,
            id: "runtime-job",
            label: "Index refresh",
            status: "complete",
          },
        ],
      },
    });

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActivityCenter activity={activity} activeSessionId="session-1" />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole("heading", {name: "Runtime-wide"})).toBeInTheDocument();
    expect(screen.getByText("Index refresh")).toBeInTheDocument();
    expect(screen.getByText("Best recorded evidence")).toBeInTheDocument();
    expect(screen.getByText("All focused tests passed")).toBeInTheDocument();
  });
});
