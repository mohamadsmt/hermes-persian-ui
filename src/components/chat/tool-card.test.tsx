import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ToolCard } from "./tool-card";

afterEach(cleanup);

const labels = {
  running: "Running",
  complete: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
  queued: "Queued",
  input: "Input",
  output: "Output",
  details: "Details",
};

describe("ToolCard details", () => {
  it.each(["queued", "running", "complete", "failed", "cancelled"] as const)(
    "starts collapsed when status is %s",
    (status) => {
      render(
        <ToolCard
          tool={{ id: status, name: "terminal", status, output: "plain output" }}
          labels={labels}
        />,
      );

      expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("plain output")).not.toBeInTheDocument();
      expect(screen.getByTestId("tool-card")).toHaveClass(
        status === "failed" ? "tool-card--prominent" : "tool-card--disclosure",
      );
    },
  );

  it("renders plain strings raw and pretty-prints redacted structured JSON", () => {
    render(
      <ToolCard
        tool={{
          id: "tool-1",
          name: "terminal",
          status: "complete",
          input: "printf 'hello\\nworld'",
          output: '{"success":false,"token":"private","nested":{"answer":42}}',
        }}
        labels={labels}
      />,
    );

    fireEvent.click(screen.getByRole("button"));
    const blocks = document.querySelectorAll<HTMLPreElement>(".technical-block");

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toHaveTextContent("printf 'hello\\nworld'");
    expect(blocks[0].textContent).not.toMatch(/^"/u);
    expect(blocks[1].textContent).toContain('"token": "[REDACTED]"');
    expect(blocks[1].textContent).toContain('"answer": 42');
    expect(blocks[1].textContent).not.toContain("private");
  });
});
