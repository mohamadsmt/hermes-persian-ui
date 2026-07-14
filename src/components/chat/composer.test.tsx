import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "./composer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const labels = {
  placeholder: "Message",
  send: "Send",
  stop: "Stop",
  attach: "Attach",
  removeAttachment: "Remove",
  attachmentFailed: "Failed",
  queue: "Queue",
  editQueued: "Edit",
  deleteQueued: "Delete",
  steer: "Steer",
  voice: "Voice",
  stopRecording: "Stop recording",
  transcribe: "Transcribe",
  cancel: "Cancel",
  dropFiles: "Drop files",
  commandPalette: "Commands",
};

function renderComposer(overrides: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const props: React.ComponentProps<typeof Composer> = {
    sessionId: "stored-1",
    value: "سلام",
    attachments: [],
    queue: [],
    commands: [{ name: "help", description: "Show help" }],
    labels,
    onChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onSteer: vi.fn(),
    onAttach: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onReplaceQueued: vi.fn(),
    onRemoveQueued: vi.fn(),
    ...overrides,
  };
  render(<Composer {...props} />);
  return props;
}

describe("composer keyboard and command behavior", () => {
  it("does not submit Enter while an IME composition is active", () => {
    const props = renderComposer();
    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", isComposing: true });
    expect(props.onSend).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(props.onSend).toHaveBeenCalledWith("سلام");
  });

  it("autocompletes an advertised slash command without dispatching it", () => {
    const onChange = vi.fn();
    const onSend = vi.fn();
    renderComposer({ value: "/he", onChange, onSend });
    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(textarea, { key: "Tab", code: "Tab" });
    expect(onChange).toHaveBeenCalledWith("/help ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("passes dropped attachments across the transport boundary", () => {
    const onAttach = vi.fn();
    renderComposer({ onAttach });
    const input = screen.getByTestId("attachment-input");
    const file = new File(["data"], "sample.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAttach).toHaveBeenCalledWith([file]);
  });

  it("hides attachment entry points when the negotiated capability is absent", () => {
    const onAttach = vi.fn();
    renderComposer({ attachmentsEnabled: false, onAttach });
    expect(screen.queryByTestId("attach-file")).not.toBeInTheDocument();

    const composer = screen.getByTestId("composer").parentElement;
    const file = new File(["data"], "sample.txt", { type: "text/plain" });
    fireEvent.drop(composer!, { dataTransfer: { files: [file] } });
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("waits for uploads and ignores failed-only attachments as sendable content", () => {
    const pending = {
      id: "pending",
      name: "pending.txt",
      kind: "file" as const,
      size: 1,
      mimeType: "text/plain",
      status: "uploading" as const,
    };
    renderComposer({ value: "send later", attachments: [pending] });
    expect(screen.getByTestId("send-message")).toBeDisabled();
    cleanup();

    renderComposer({
      value: "",
      attachments: [{ ...pending, id: "failed", status: "failed", error: "failed" }],
    });
    expect(screen.getByTestId("send-message")).toBeDisabled();
  });

  it("publishes its measured block size to the chat layout", () => {
    class ImmediateResizeObserver implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}

      disconnect() {}
      unobserve() {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              borderBoxSize: [{ blockSize: 196, inlineSize: 720 }],
              contentBoxSize: [{ blockSize: 172, inlineSize: 696 }],
              devicePixelContentBoxSize: [{ blockSize: 172, inlineSize: 696 }],
              contentRect: target.getBoundingClientRect(),
            },
          ],
          this,
        );
      }
    }
    vi.stubGlobal("ResizeObserver", ImmediateResizeObserver);

    const props: React.ComponentProps<typeof Composer> = {
      sessionId: "stored-1",
      value: "",
      attachments: [],
      queue: Array.from({ length: 10 }, (_, index) => `Queued ${index}`),
      commands: [],
      labels,
      onChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      onSteer: vi.fn(),
      onAttach: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onReplaceQueued: vi.fn(),
      onRemoveQueued: vi.fn(),
    };
    const { container } = render(
      <section className="chat-main">
        <Composer {...props} />
      </section>,
    );

    const chatMain = container.querySelector<HTMLElement>(".chat-main");
    expect(chatMain?.style.getPropertyValue("--composer-block-size")).toBe("196px");
    expect(screen.getByRole("region", { name: "Queue" })).toHaveClass("composer-queue");
  });
});
