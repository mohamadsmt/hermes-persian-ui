"use client";

import { Search, Terminal, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import type { CommandOption } from "./ui-types";
import { filterCommandOptions } from "./command-catalog";

type CommandPaletteProps = {
  open: boolean;
  commands: CommandOption[];
  labels: { title: string; search: string; noResults: string; close: string };
  unavailableReason?: string;
  onClose: () => void;
  onSelect: (command: CommandOption) => void;
};

export function CommandPalette({
  open,
  commands,
  labels,
  unavailableReason,
  onClose,
  onSelect,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    return filterCommandOptions(commands, query);
  }, [commands, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      setQuery("");
      setSelectedIndex(0);
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
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (!matches.length) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((index) => (index + 1) % matches.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((index) => index === 0 ? matches.length - 1 : index - 1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const command = matches[Math.min(selectedIndex, matches.length - 1)];
                if (command) onSelect(command);
              }
            }}
            placeholder={labels.search}
            dir="auto"
          />
        </label>
        <div className="command-palette__list" role="listbox">
          {unavailableReason ? (
            <p dir="auto">{unavailableReason}</p>
          ) : matches.length ? (
            matches.map((command, index) => {
              const previousCategory = matches[index - 1]?.categoryLabel;
              return (
                <Fragment key={`${command.category ?? "commands"}:${command.name}`}>
                  {command.categoryLabel && command.categoryLabel !== previousCategory ? (
                    <div className="command-palette__group" role="presentation">
                      {command.categoryLabel}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selectedIndex}
                    className={index === selectedIndex ? "command-option--selected" : undefined}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => onSelect(command)}
                  >
                    <bdi dir="ltr">/{command.name}</bdi>
                    <span className="bidi-block" dir="auto">{command.description}</span>
                  </button>
                </Fragment>
              );
            })
          ) : (
            <p>{labels.noResults}</p>
          )}
        </div>
      </section>
    </div>
  );
}
