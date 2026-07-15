import { describe, expect, it } from "vitest";

import type { CommandCatalog, SlashCompletionResult } from "@/lib/hermes";

import {
  commandSurface,
  filterCommandGroups,
  filterCommandOptions,
  findCommandOption,
  isSlashCommandInput,
  normalizeCommandCatalog,
  normalizeSlashCompletions,
  parseSlashCommand,
  resolveCanonicalCommandName,
  unavailableCommandGuidance,
} from "./command-catalog";

const realShapeCatalog: CommandCatalog = {
  pairs: [
    ["/sessions", "Browse sessions"],
    ["/HELP", "Description authored by Hermes"],
    ["/help", "duplicate must not replace the first description"],
    ["/deploy-skill", "Run the deploy skill"],
    ["/quick-note", "Save a quick note"],
    ["/logs", "Show gateway logs"],
    ["/model", "Select a model"],
  ],
  categories: [
    { name: "Session", pairs: [["/sessions", "Browse sessions"]] },
    {
      name: "Info",
      pairs: [
        ["/help", "Description authored by Hermes"],
        ["/model", "Select a model"],
      ],
    },
    { name: "User commands", pairs: [["/quick-note", "Save a quick note"]] },
    {
      name: "TUI",
      pairs: [
        ["/sessions", "Browse sessions"],
        ["/logs", "Show gateway logs"],
      ],
    },
  ],
  canon: {
    "/sessions": "/sessions",
    "/help": "/help",
    "/h": "/help",
    "/fork": "/branch",
    "/model": "/model",
  },
  sub: {
    "/model": ["gpt-5", "gpt-5", "claude"],
  },
  skillCount: 1,
  warning: "one skill directory could not be scanned",
};

describe("normalizeCommandCatalog", () => {
  it("parses Hermes pairs/categories/canon/sub, deduplicates, and preserves descriptions", () => {
    const catalog = normalizeCommandCatalog(realShapeCatalog);

    expect(catalog.allCommands.filter((command) => command.name.toLowerCase() === "help")).toHaveLength(1);
    expect(findCommandOption(catalog, "/H")?.description).toBe("Description authored by Hermes");
    expect(findCommandOption(catalog, "h")?.canonicalName).toBe("help");
    expect(findCommandOption(catalog, "model")?.subcommands).toEqual(["gpt-5", "claude"]);
    expect(findCommandOption(catalog, "model")?.usage).toBe("/model gpt-5 | claude");
    expect(catalog.aliases.h).toBe("help");
    expect(catalog.skillCount).toBe(1);
    expect(catalog.warning).toBe("one skill directory could not be scanned");
  });

  it("places uncategorized dynamic commands in the Persian skills group", () => {
    const catalog = normalizeCommandCatalog(realShapeCatalog);
    const skills = catalog.groups.find((group) => group.label === "مهارت‌ها");

    expect(skills?.commands.map((command) => command.name)).toEqual(["deploy-skill"]);
    expect(skills?.commands[0]?.source).toBe("skill");
    expect(catalog.groups.find((group) => group.name === "Session")?.label).toBe("نشست‌ها");
    expect(catalog.groups.find((group) => group.name === "User commands")?.label).toBe("فرمان‌های سریع");
  });

  it("includes category-only pairs and prefers a web category over a duplicate TUI entry", () => {
    const catalog = normalizeCommandCatalog({
      ...realShapeCatalog,
      pairs: [["/help", "Help"]],
    });

    expect(findCommandOption(catalog, "sessions")?.category).toBe("Session");
    expect(findCommandOption(catalog, "sessions")?.surface).toBe("ui");
    expect(findCommandOption(catalog, "model")?.category).toBe("Info");
  });

  it("hides terminal-only commands from web menus but keeps them for manual guidance", () => {
    const catalog = normalizeCommandCatalog(realShapeCatalog);

    expect(catalog.commands.some((command) => command.name === "logs")).toBe(false);
    expect(catalog.allCommands.find((command) => command.name === "logs")?.surface).toBe("unavailable");
    expect(catalog.groups.some((group) => group.name === "TUI")).toBe(false);
    expect(commandSurface("sessions", "TUI")).toBe("ui");
    expect(commandSurface("redraw", "Session")).toBe("unavailable");
    expect(unavailableCommandGuidance("/image")).toContain("دکمهٔ پیوست");
  });
});

describe("slash command recognition and aliases", () => {
  it("recognizes ASCII command names without mistaking absolute paths for commands", () => {
    expect(isSlashCommandInput("/help")).toBe(true);
    expect(isSlashCommandInput("/MODEL gpt-5")).toBe(true);
    expect(isSlashCommandInput("/my-skill arg")).toBe(true);
    expect(isSlashCommandInput("/Users/mohamadsmt/project")).toBe(false);
    expect(isSlashCommandInput("/tmp/file.txt")).toBe(false);
    expect(isSlashCommandInput(" /help")).toBe(false);
    expect(parseSlashCommand("/QUEUE   keep spacing")?.normalizedName).toBe("queue");
    expect(parseSlashCommand("/QUEUE   keep spacing")?.args).toBe("keep spacing");
  });

  it("resolves aliases case-insensitively and fails closed on a loop", () => {
    expect(resolveCanonicalCommandName("/H", realShapeCatalog.canon)).toBe("help");
    expect(resolveCanonicalCommandName("Fork", realShapeCatalog.canon)).toBe("branch");
    expect(resolveCanonicalCommandName("a", { a: "b", b: "a" })).toBe("a");
  });
});

describe("shared command filtering", () => {
  it("ranks exact/prefix names and searches Hermes descriptions", () => {
    const catalog = normalizeCommandCatalog(realShapeCatalog);

    expect(filterCommandOptions(catalog.commands, "/he").map((command) => command.name)).toEqual(["HELP"]);
    expect(filterCommandOptions(catalog.commands, "deploy").map((command) => command.name)).toEqual(["deploy-skill"]);
    expect(filterCommandOptions(catalog.commands, "authored").map((command) => command.name)).toEqual(["HELP"]);
    expect(filterCommandGroups(catalog.groups, "quick")).toMatchObject([
      { name: "User commands", commands: [{ name: "quick-note" }] },
    ]);
  });
});

describe("normalizeSlashCompletions", () => {
  it("honors replace_from, removes duplicate slash prefixes, deduplicates, and hides TUI extras", () => {
    const catalog = normalizeCommandCatalog(realShapeCatalog);
    const result: SlashCompletionResult = {
      replaceFrom: 1,
      items: [
        { text: "/logs", display: "/logs", meta: "terminal only" },
        { text: "/help", display: "/help", meta: "Show help" },
        { text: "HELP", display: "/HELP", meta: "duplicate" },
      ],
    };

    expect(normalizeSlashCompletions("/he", result, catalog)).toEqual([
      expect.objectContaining({
        text: "help",
        value: "/help",
        replaceFrom: 1,
        commandName: "help",
      }),
    ]);
  });

  it("replaces only the active argument using Hermes' exact UTF-16 offset", () => {
    const result: SlashCompletionResult = {
      replaceFrom: 11,
      items: [{ text: "medium", display: "medium", meta: "Set medium effort" }],
    };

    expect(normalizeSlashCompletions("/reasoning m", result)).toEqual([
      expect.objectContaining({
        value: "/reasoning medium",
        replaceFrom: 11,
        commandName: "reasoning",
      }),
    ]);
  });
});
