import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "./composer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

function ControlledComposer({
  initialValue,
  onSend = vi.fn<(value: string) => void>(),
  onCompleteSlash,
}: {
  initialValue: string;
  onSend?: (value: string) => void;
  onCompleteSlash?: React.ComponentProps<typeof Composer>["onCompleteSlash"];
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <Composer
      sessionId="stored-1"
      value={value}
      attachments={[]}
      queue={[]}
      commands={[
        { name: "help", description: "Show help", categoryLabel: "Info" },
        { name: "reasoning", description: "Set effort", categoryLabel: "Configuration" },
      ]}
      labels={labels}
      onChange={setValue}
      onSend={onSend}
      onStop={vi.fn()}
      onSteer={vi.fn()}
      onAttach={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onReplaceQueued={vi.fn()}
      onRemoveQueued={vi.fn()}
      onCompleteSlash={onCompleteSlash}
    />
  );
}

describe("composer keyboard and command behavior", () => {
  it("does not submit Enter while an IME composition is active", () => {
    const props = renderComposer();
    const textarea = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
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
    const textarea = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Tab", code: "Tab" });
    expect(onChange).toHaveBeenCalledWith("/help ");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("opens the categorized catalog on slash and closes it with Escape", () => {
    renderComposer({
      value: "/",
      commands: [
        { name: "help", description: "Show help", categoryLabel: "Info" },
        { name: "skill-test", description: "Dynamic skill", categoryLabel: "Skills" },
      ],
    });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    expect(screen.getByText("Info")).toBeInTheDocument();
    expect(screen.getByText("Skills")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Message" }), { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
  });

  it("uses Enter once to insert a command and the next Enter to execute it", () => {
    const onSend = vi.fn();
    render(<ControlledComposer initialValue="/he" onSend={onSend} />);
    const textarea = screen.getByRole("combobox", { name: "Message" });

    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(textarea).toHaveValue("/help ");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/help");
  });

  it("applies argument completions from Hermes at the exact replace_from offset", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(async () => ({
      replaceFrom: 11,
      items: [{ text: "medium", display: "medium", meta: "Set medium effort" }],
    }));
    render(<ControlledComposer initialValue="/reasoning m" onCompleteSlash={complete} />);
    const textarea = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(12, 12);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(110);
    });
    expect(complete).toHaveBeenCalledWith("/reasoning m", expect.any(AbortSignal));
    fireEvent.keyDown(textarea, { key: "Tab", code: "Tab" });
    expect(textarea).toHaveValue("/reasoning medium");
    expect(textarea).toHaveFocus();
  });

  it("preserves text after the caret when applying a completion", async () => {
    vi.useFakeTimers();
    const complete = vi.fn(async () => ({
      replaceFrom: 11,
      items: [{ text: "medium", display: "medium", meta: "Set medium effort" }],
    }));
    render(<ControlledComposer initialValue="/reasoning m keep" onCompleteSlash={complete} />);
    const textarea = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(12, 12);
    fireEvent.select(textarea);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(110);
    });
    expect(complete).toHaveBeenLastCalledWith("/reasoning m", expect.any(AbortSignal));
    fireEvent.keyDown(textarea, { key: "Tab", code: "Tab" });
    expect(textarea).toHaveValue("/reasoning medium keep");
  });

  it("aborts and ignores a stale completion response", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: {
      replaceFrom: number;
      items: Array<{ text: string; display: string; meta: string }>;
    }) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const complete = vi.fn((text: string, signal: AbortSignal) => {
      if (text === "/h") {
        firstSignal = signal;
        return new Promise<{
          replaceFrom: number;
          items: Array<{ text: string; display: string; meta: string }>;
        }>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        replaceFrom: 1,
        items: [{ text: "version", display: "/version", meta: "Show version" }],
      });
    });
    render(<ControlledComposer initialValue="/h" onCompleteSlash={complete} />);
    const textarea = screen.getByRole("combobox", { name: "Message" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(110);
    });
    fireEvent.change(textarea, { target: { value: "/v", selectionStart: 2 } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(110);
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(screen.getByRole("option", { name: /version/iu })).toBeInTheDocument();

    await act(async () => {
      resolveFirst?.({
        replaceFrom: 1,
        items: [{ text: "help", display: "/help", meta: "Show help" }],
      });
      await Promise.resolve();
    });
    expect(screen.queryByRole("option", { name: /help/iu })).not.toBeInTheDocument();
  });

  it("keeps focus while a command is chosen with the pointer", () => {
    render(<ControlledComposer initialValue="/" />);
    const textarea = screen.getByRole("combobox", { name: "Message" });
    textarea.focus();
    const option = screen.getByRole("option", { name: /help/iu });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(textarea).toHaveValue("/help ");
    expect(textarea).toHaveFocus();
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
