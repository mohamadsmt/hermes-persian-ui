"use client";

import { Search, Terminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { CommandOption } from "./ui-types";

type CommandPaletteProps = {
  open: boolean;
  commands: CommandOption[];
  labels: { title: string; search: string; noResults: string; close: string };
  onClose: () => void;
  onSelect: (command: CommandOption) => void;
};

export function CommandPalette({ open, commands, labels, onClose, onSelect }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.name} ${command.description ?? ""}`.toLocaleLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      setQuery("");
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop command-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      data-testid="command-palette"
    >
      <section className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title">
        <header>
          <Terminal aria-hidden="true" size={20} />
          <h2 id="command-palette-title">{labels.title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label={labels.close}>
            <X aria-hidden="true" size={19} />
          </button>
        </header>
        <label className="command-palette__search">
          <Search aria-hidden="true" size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.search}
            dir="auto"
          />
        </label>
        <div className="command-palette__list" role="listbox">
          {matches.length ? (
            matches.map((command) => (
              <button
                type="button"
                role="option"
                aria-selected="false"
                key={command.name}
                onClick={() => onSelect(command)}
              >
                <bdi dir="ltr">/{command.name}</bdi>
                <span className="bidi-block">{command.description}</span>
              </button>
            ))
          ) : (
            <p>{labels.noResults}</p>
          )}
        </div>
      </section>
    </div>
  );
}
