"use client";

import {
  ArrowUp,
  FileText,
  Image as ImageIcon,
  Mic,
  Paperclip,
  SendHorizonal,
  Square,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  Fragment,
  KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type {
  CommandOption,
  ComposerAttachment,
  SlashCompletion,
} from "./ui-types";
import { filterCommandOptions } from "./command-catalog";

type ComposerProps = {
  sessionId: string;
  value: string;
  attachments: ComposerAttachment[];
  queue: string[];
  commands: CommandOption[];
  slashAvailable?: boolean;
  slashUnavailableReason?: string;
  disabled?: boolean;
  running?: boolean;
  attachmentsEnabled?: boolean;
  voiceEnabled?: boolean;
  labels: {
    placeholder: string;
    send: string;
    stop: string;
    attach: string;
    removeAttachment: string;
    attachmentFailed: string;
    queue: string;
    editQueued: string;
    deleteQueued: string;
    steer: string;
    voice: string;
    stopRecording: string;
    transcribe: string;
    cancel: string;
    dropFiles: string;
    commandPalette: string;
  };
  onChange: (value: string) => void;
  onSend: (value: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onSteer: (value: string) => Promise<void> | void;
  onAttach: (files: File[]) => Promise<void> | void;
  onRemoveAttachment: (id: string) => void;
  onReplaceQueued: (index: number, value: string) => void;
  onRemoveQueued: (index: number) => void;
  onVoice?: (blob: Blob) => Promise<void> | void;
  onVoiceError?: (message: string) => void;
  onCompleteSlash?: (text: string, signal: AbortSignal) => Promise<SlashCompletion>;
};

type MenuOption = {
  command: CommandOption;
  insertText: string;
  replaceFrom: number;
  appendSpace: boolean;
};

const SLASH_COMPLETION_DEBOUNCE_MS = 100;

function attachmentIcon(attachment: ComposerAttachment) {
  if (attachment.kind === "image") return ImageIcon;
  return FileText;
}

export function Composer({
  value,
  attachments,
  queue,
  commands,
  slashAvailable = true,
  slashUnavailableReason,
  disabled,
  running,
  attachmentsEnabled = true,
  voiceEnabled,
  labels,
  onChange,
  onSend,
  onStop,
  onSteer,
  onAttach,
  onRemoveAttachment,
  onRemoveQueued,
  onVoice,
  onVoiceError,
  onCompleteSlash,
}: ComposerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [completionState, setCompletionState] = useState<{
    input: string;
    options: MenuOption[];
  }>({ input: "", options: [] });
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const hasReadyAttachment = attachments.some((attachment) => attachment.status === "ready");
  const attachmentBusy = attachments.some(
    (attachment) => attachment.status === "pending" || attachment.status === "uploading",
  );

  const cursorPosition = Math.max(0, Math.min(value.length, selectionStart ?? value.length));
  const slashInput = value.slice(0, cursorPosition);
  const commandQuery = slashInput.startsWith("/") && !/\s/u.test(slashInput.slice(1))
    ? slashInput.slice(1)
    : null;
  const catalogOptions: MenuOption[] = commandQuery === null
    ? []
    : filterCommandOptions(commands, commandQuery).map((command) => ({
        command,
        insertText: command.name,
        replaceFrom: 1,
        appendSpace: true,
      }));
  const completionOptions = completionState.input === slashInput ? completionState.options : [];
  const commandMatches = slashInput === "/" || !completionOptions.length
    ? catalogOptions
    : completionOptions;
  const menuOpen = slashAvailable
    && !slashMenuDismissed
    && slashInput.startsWith("/")
    && commandMatches.length > 0;
  const activeCommandIndex = commandMatches.length
    ? Math.min(selectedCommand, commandMatches.length - 1)
    : 0;

  useEffect(() => {
    if (
      !slashAvailable
      || !onCompleteSlash
      || slashMenuDismissed
      || !slashInput.startsWith("/")
      || slashInput === "/"
    ) {
      return;
    }

    const controller = new AbortController();
    let current = true;
    const timer = window.setTimeout(() => {
      void onCompleteSlash(slashInput, controller.signal).then((result) => {
        if (!current || controller.signal.aborted) return;
        const replaceFrom = Math.max(0, Math.min(slashInput.length, result.replaceFrom));
        const prefix = slashInput.slice(0, replaceFrom);
        const completingCommand = replaceFrom <= 1 && !/\s/u.test(slashInput.slice(1));
        setCompletionState({ input: slashInput, options: result.items.map((item, index) => {
          let insertText = item.text;
          if (prefix.endsWith("/") && insertText.startsWith("/")) insertText = insertText.slice(1);
          const display = (item.display || item.text).replace(/^\//u, "");
          return {
            command: {
              name: display || `completion-${index}`,
              ...(item.meta ? { description: item.meta } : {}),
              source: "completion",
            },
            insertText,
            replaceFrom,
            appendSpace: completingCommand,
          };
        }) });
      }).catch((error: unknown) => {
        if (!current || controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setCompletionState({ input: slashInput, options: [] });
      });
    }, SLASH_COMPLETION_DEBOUNCE_MS);

    return () => {
      current = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [onCompleteSlash, slashAvailable, slashInput, slashMenuDismissed]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(240, Math.max(48, textarea.scrollHeight))}px`;
  }, [value]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const chatMain = root?.closest(".chat-main") as HTMLElement | null;
    if (!root || !chatMain) return;

    const updateComposerSize = (entry?: ResizeObserverEntry) => {
      const borderBox = entry?.borderBoxSize;
      const observedBox = Array.isArray(borderBox) ? borderBox[0] : borderBox;
      const blockSize =
        observedBox?.blockSize ?? entry?.contentRect.height ?? root.getBoundingClientRect().height;
      if (blockSize > 0) {
        chatMain.style.setProperty("--composer-block-size", `${Math.ceil(blockSize)}px`);
      }
    };

    updateComposerSize();
    const observer = new ResizeObserver((entries) => updateComposerSize(entries[0]));
    observer.observe(root);

    return () => {
      observer.disconnect();
      chatMain.style.removeProperty("--composer-block-size");
    };
  }, []);

  useEffect(
    () => () => {
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    },
    [recordingUrl],
  );

  function submit(steer = false) {
    const trimmed = value.trim();
    if (attachmentBusy || (!trimmed && !hasReadyAttachment)) return;
    if (steer) void onSteer(trimmed);
    else void onSend(trimmed);
  }

  function selectCommand(option: MenuOption) {
    const textarea = textareaRef.current;
    const liveCursor = textarea && document.activeElement === textarea
      ? textarea.selectionStart
      : cursorPosition;
    const cursor = Math.max(
      option.replaceFrom,
      Math.min(value.length, liveCursor),
    );
    const prefix = value.slice(0, option.replaceFrom);
    const suffix = option.appendSpace && !option.insertText.endsWith(" ") ? " " : "";
    const inserted = `${prefix}${option.insertText}${suffix}`;
    const next = `${inserted}${value.slice(cursor)}`;
    const nextCursor = inserted.length;
    setSelectedCommand(0);
    setSelectionStart(nextCursor);
    setSlashMenuDismissed(true);
    onChange(next);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedCommand((index) => (index + 1) % commandMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedCommand((index) =>
          index === 0 ? commandMatches.length - 1 : index - 1,
        );
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const option = commandMatches[activeCommandIndex] ?? commandMatches[0];
        if (option) selectCommand(option);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashMenuDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit(running && event.altKey);
    }
  }

  function acceptFiles(files: FileList | File[]) {
    if (!attachmentsEnabled) return;
    const list = Array.from(files);
    if (list.length) void onAttach(list);
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (images.length) {
      event.preventDefault();
      void onAttach(images);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    acceptFiles(event.dataTransfer.files);
  }

  async function toggleRecording() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        const url = URL.createObjectURL(blob);
        setRecordingBlob(blob);
        setRecordingUrl(url);
        setRecording(false);
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      setRecording(true);
    } catch (error) {
      onVoiceError?.(error instanceof Error ? error.message : String(error));
    }
  }

  function clearRecording() {
    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    setRecordingBlob(null);
    setRecordingUrl(null);
  }

  async function transcribeRecording() {
    if (!recordingBlob || !onVoice) return;
    await onVoice(recordingBlob);
    clearRecording();
  }

  return (
    <div
      ref={rootRef}
      className={`composer-wrap ${dragging ? "composer-wrap--dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (attachmentsEnabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (attachmentsEnabled) onDrop(event);
        else event.preventDefault();
      }}
    >
      {dragging ? <div className="composer-drop-overlay">{labels.dropFiles}</div> : null}

      {queue.length ? (
        <section className="composer-queue" aria-label={labels.queue}>
          <h3>{labels.queue}</h3>
          {queue.map((item, index) => (
            <div className="queued-prompt" key={`${item}-${index}`}>
              <span dir="auto" className="bidi-block">
                {item}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={labels.editQueued}
                onClick={() => {
                  onChange(item);
                  onRemoveQueued(index);
                  textareaRef.current?.focus();
                }}
              >
                <WandSparkles aria-hidden="true" size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={labels.deleteQueued}
                onClick={() => onRemoveQueued(index)}
              >
                <Trash2 aria-hidden="true" size={16} />
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {attachments.length ? (
        <div className="attachment-list">
          {attachments.map((attachment) => {
            const Icon = attachmentIcon(attachment);
            return (
              <div
                className={`attachment-chip attachment-chip--${attachment.status}`}
                key={attachment.id}
                data-testid="attachment-item"
              >
                {attachment.previewUrl ? (
                  // Blob URLs are created locally and revoked when the item is removed.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={attachment.previewUrl} alt="" />
                ) : (
                  <Icon aria-hidden="true" size={17} />
                )}
                <span dir="auto">{attachment.name}</span>
                {attachment.status === "failed" ? (
                  <span className="danger-text">{labels.attachmentFailed}</span>
                ) : null}
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  aria-label={`${labels.removeAttachment}: ${attachment.name}`}
                >
                  <X aria-hidden="true" size={15} />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}

      {recordingUrl ? (
        <div className="voice-preview">
          <audio controls src={recordingUrl} />
          <button type="button" className="button button--primary" onClick={() => void transcribeRecording()}>
            {labels.transcribe}
          </button>
          <button type="button" className="button button--ghost" onClick={clearRecording}>
            {labels.cancel}
          </button>
        </div>
      ) : null}

      <div className="composer" data-testid="composer">
        {menuOpen ? (
          <div id="slash-command-menu" className="command-menu" role="listbox" aria-label={labels.commandPalette}>
            {commandMatches.map((option, index) => {
              const command = option.command;
              const previousCategory = commandMatches[index - 1]?.command.categoryLabel;
              return (
                <Fragment key={`${command.source ?? "catalog"}:${command.name}:${option.insertText}:${index}`}>
                  {command.categoryLabel && command.categoryLabel !== previousCategory ? (
                    <div className="command-menu__group" role="presentation">
                      {command.categoryLabel}
                    </div>
                  ) : null}
                  <button
                    id={`slash-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeCommandIndex}
                    className={index === activeCommandIndex ? "command-option--selected" : undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSelectedCommand(index)}
                    onClick={() => selectCommand(option)}
                  >
                    <bdi dir="ltr">
                      {command.source === "completion" && option.replaceFrom > 1
                        ? command.name
                        : `/${command.name}`}
                    </bdi>
                    <span dir="auto">{command.description}</span>
                  </button>
                </Fragment>
              );
            })}
          </div>
        ) : null}
        {!slashAvailable && value.startsWith("/") && slashUnavailableReason ? (
          <div className="command-menu command-menu--unavailable" role="status" dir="auto">
            {slashUnavailableReason}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setSelectedCommand(0);
            setSelectionStart(event.target.selectionStart);
            setSlashMenuDismissed(false);
            onChange(event.target.value);
          }}
          onSelect={(event) => {
            setSelectionStart(event.currentTarget.selectionStart);
          }}
          onClick={(event) => {
            setSelectionStart(event.currentTarget.selectionStart);
            setSlashMenuDismissed(false);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          placeholder={labels.placeholder}
          aria-label={labels.placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-activedescendant={menuOpen ? `slash-option-${activeCommandIndex}` : undefined}
          aria-controls={menuOpen ? "slash-command-menu" : undefined}
          aria-expanded={menuOpen}
          aria-haspopup="listbox"
          dir="auto"
          disabled={disabled}
          rows={1}
        />

        <div className="composer__actions">
          <input
            ref={fileRef}
            type="file"
            hidden
            multiple
            accept="image/*,.pdf,.txt,.md,.json,.yaml,.yml,.csv,.log,.diff,.patch"
            data-testid="attachment-input"
            onChange={(event) => {
              if (event.target.files) acceptFiles(event.target.files);
              event.target.value = "";
            }}
          />
          {attachmentsEnabled ? (
            <button
              type="button"
              className="icon-button"
              aria-label={labels.attach}
              data-testid="attach-file"
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
            >
              <Paperclip aria-hidden="true" size={20} />
            </button>
          ) : null}
          {voiceEnabled && onVoice ? (
            <button
              type="button"
              className={`icon-button ${recording ? "icon-button--recording" : ""}`}
              aria-label={recording ? labels.stopRecording : labels.voice}
              onClick={() => void toggleRecording()}
              disabled={disabled}
            >
              {recording ? <Square aria-hidden="true" size={18} /> : <Mic aria-hidden="true" size={20} />}
            </button>
          ) : null}
          {running ? (
            <button
              type="button"
              className="icon-button icon-button--stop"
              aria-label={labels.stop}
              data-testid="stop-run"
              onClick={() => void onStop()}
            >
              <Square aria-hidden="true" size={17} />
            </button>
          ) : null}
          <button
            type="button"
            className="composer__send"
            aria-label={running ? labels.steer : labels.send}
            data-testid="send-message"
            onClick={() => submit(false)}
            disabled={disabled || attachmentBusy || (!value.trim() && !hasReadyAttachment)}
          >
            {running ? <SendHorizonal aria-hidden="true" size={19} /> : <ArrowUp aria-hidden="true" size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
}
