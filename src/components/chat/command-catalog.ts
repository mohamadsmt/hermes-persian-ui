import type { CommandCatalog, SlashCompletionResult } from "@/lib/hermes";

import type { CommandOption } from "./ui-types";

const SKILLS_CATEGORY = "Skills";

const PERSIAN_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  session: "نشست‌ها",
  info: "اطلاعات",
  configuration: "تنظیمات",
  "tools & skills": "ابزارها و مهارت‌ها",
  "user commands": "فرمان‌های سریع",
  exit: "خروج",
  tui: "رابط ترمینال",
  skills: "مهارت‌ها",
};

const TERMINAL_ONLY_CATEGORIES = new Set(["tui", "exit"]);

/** Commands whose behavior belongs to the browser UI rather than generic RPC dispatch. */
export const UI_OWNED_COMMANDS: ReadonlySet<string> = new Set([
  "new",
  "reset",
  "clear",
  "branch",
  "fork",
  "resume",
  "sessions",
  "switch",
  "model",
  "profile",
  "title",
  "reasoning",
  "yolo",
  "queue",
  "q",
  "steer",
  "help",
  "commands",
  "journey",
  "copy",
]);

/**
 * Commands that rely on terminal state or do not have a safe browser surface.
 * They remain recognizable when manually typed, but never appear as suggestions.
 */
export const WEB_UNAVAILABLE_COMMANDS: ReadonlySet<string> = new Set([
  "redraw",
  "prompt",
  "compose",
  "skin",
  "mouse",
  "logs",
  "paste",
  "image",
  "quit",
  "exit",
  "update",
  "restart",
  "handoff",
  "pet",
  "hatch",
  "generate-pet",
  "compact",
  "details",
  "statusbar",
  "sb",
  "timestamps",
  "ts",
  "verbose",
  "footer",
  "indicator",
  "voice",
  "busy",
  "sethome",
  "set-home",
  "approve",
  "deny",
]);

export type WebCommandSurface = "ui" | "gateway" | "unavailable";
export type WebCommandSource = "builtin" | "quick" | "skill";

export interface WebCommandOption extends CommandOption {
  /** Slash-less canonical command name, preserving the gateway's casing. */
  canonicalName: string;
  aliases: string[];
  subcommands: string[];
  category: string;
  categoryLabel: string;
  source: WebCommandSource;
  surface: WebCommandSurface;
}

export interface WebCommandGroup {
  /** Stable, case-folded category key. */
  key: string;
  /** Category name authored by Hermes. */
  name: string;
  /** Localized presentation label. */
  label: string;
  commands: WebCommandOption[];
}

export interface NormalizedCommandCatalog {
  /** Commands suitable for menus and pickers. */
  commands: WebCommandOption[];
  /** Includes terminal-only commands so manually typed input can be explained. */
  allCommands: WebCommandOption[];
  groups: WebCommandGroup[];
  /** Slash-less, case-folded alias -> canonical command. */
  aliases: Record<string, string>;
  subcommands: Record<string, string[]>;
  skillCount: number;
  warning?: string;
}

export interface ParsedSlashCommand {
  name: string;
  normalizedName: string;
  args: string;
  rawArgs: string;
}

export interface NormalizedSlashCompletion {
  id: string;
  /** Replacement authored by Hermes, normalized only to prevent a duplicate slash. */
  text: string;
  display: string;
  description: string;
  replaceFrom: number;
  /** Composer value after applying the replacement from `replaceFrom` to the end. */
  value: string;
  commandName?: string;
}

export const SLASH_COMMAND_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\s|$)/;

function caseFold(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

export function normalizeCommandName(value: string): string {
  return caseFold(value.trim().replace(/^\/+/, ""));
}

export function parseSlashCommand(value: string): ParsedSlashCommand | null {
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s|$)/.exec(value);
  const name = match?.[1];
  if (!name) return null;

  const remainder = value.slice(name.length + 1);
  return {
    name,
    normalizedName: normalizeCommandName(name),
    args: remainder.trim(),
    rawArgs: remainder.replace(/^\s+/, ""),
  };
}

export function isSlashCommandInput(value: string): boolean {
  return SLASH_COMMAND_PATTERN.test(value);
}

export function localizeCommandCategory(name: string, locale = "fa"): string {
  if (!locale.toLocaleLowerCase().startsWith("fa")) {
    return caseFold(name) === caseFold(SKILLS_CATEGORY) ? "Skills" : name;
  }
  return PERSIAN_CATEGORY_LABELS[caseFold(name)] ?? name;
}

function categoryIsTerminalOnly(name: string | undefined): boolean {
  return Boolean(name && TERMINAL_ONLY_CATEGORIES.has(caseFold(name)));
}

export function commandSurface(name: string, category?: string): WebCommandSurface {
  const normalized = normalizeCommandName(name);
  // Explicit browser behavior wins when Hermes also advertises the command in
  // a TUI extras bucket (notably `/sessions`).
  if (UI_OWNED_COMMANDS.has(normalized)) return "ui";
  if (WEB_UNAVAILABLE_COMMANDS.has(normalized) || categoryIsTerminalOnly(category)) {
    return "unavailable";
  }
  return "gateway";
}

export function isWebCommandUnavailable(name: string, category?: string): boolean {
  return commandSurface(name, category) === "unavailable";
}

export const isWebHiddenCommand = isWebCommandUnavailable;

const PERSIAN_UNAVAILABLE_GUIDANCE: Readonly<Record<string, string>> = {
  redraw: "این فرمان مخصوص بازطراحی رابط ترمینال است؛ رابط وب به‌صورت خودکار به‌روزرسانی می‌شود.",
  prompt: "این فرمان به ویرایشگر ترمینال وابسته است؛ متن را مستقیماً در کادر پیام ویرایش کنید.",
  compose: "این فرمان به ویرایشگر ترمینال وابسته است؛ متن را مستقیماً در کادر پیام ویرایش کنید.",
  skin: "این فرمان پوستهٔ ترمینال را تغییر می‌دهد؛ از تنظیمات ظاهری برنامه استفاده کنید.",
  mouse: "این فرمان تنظیم ماوس ترمینال است؛ رابط وب از رفتار استاندارد مرورگر استفاده می‌کند.",
  logs: "نمایش تعاملی لاگ مخصوص ترمینال است؛ وضعیت اتصال را در رابط برنامه بررسی کنید.",
  paste: "این فرمان به کلیپ‌بورد ترمینال وابسته است؛ از Paste مرورگر یا سیستم‌عامل استفاده کنید.",
  image: "این فرمان به ورودی تصویر ترمینال وابسته است؛ تصویر را با دکمهٔ پیوست اضافه کنید.",
  quit: "این فرمان برای خروج از رابط ترمینال است؛ برای خروج، تب یا پنجرهٔ برنامه را ببندید.",
  exit: "این فرمان برای خروج از رابط ترمینال است؛ برای خروج، تب یا پنجرهٔ برنامه را ببندید.",
  update: "به‌روزرسانی Hermes به ترمینال نیاز دارد؛ آن را با فرمان به‌روزرسانی Hermes در ترمینال انجام دهید.",
  restart: "راه‌اندازی دوبارهٔ Hermes از این رابط پشتیبانی نمی‌شود؛ سرویس را از ترمینال یا کنترل runtime اجرا کنید.",
  handoff: "این فرمان در حال حاضر سطح امنی در رابط وب ندارد؛ آن را در Hermes ترمینال اجرا کنید.",
  pet: "این قابلیت تصویری مخصوص رابط ترمینال است و در وب نمایش داده نمی‌شود.",
  hatch: "این قابلیت تصویری مخصوص رابط ترمینال است و در وب نمایش داده نمی‌شود.",
  "generate-pet": "این قابلیت تصویری مخصوص رابط ترمینال است و در وب نمایش داده نمی‌شود.",
  compact: "این فرمان چیدمان رابط ترمینال را تغییر می‌دهد؛ از اندازه و چیدمان خود رابط وب استفاده کنید.",
  details: "این فرمان نمایش جزئیات در ترمینال را تغییر می‌دهد و در وب سطح مستقلی ندارد.",
  voice: "این فرمان تنظیم صدای ترمینال است؛ از دکمهٔ میکروفون در کادر پیام استفاده کنید.",
};

export function unavailableCommandGuidance(name: string, locale = "fa"): string | undefined {
  const normalized = normalizeCommandName(name);
  if (!WEB_UNAVAILABLE_COMMANDS.has(normalized)) return undefined;

  if (!locale.toLocaleLowerCase().startsWith("fa")) {
    return `/${normalized} is only available in the Hermes terminal. Use the equivalent browser control instead.`;
  }
  return PERSIAN_UNAVAILABLE_GUIDANCE[normalized]
    ?? `فرمان /${normalized} به رابط ترمینال وابسته است و در وب اجرا نمی‌شود؛ از کنترل متناظر رابط برنامه استفاده کنید.`;
}

export const getWebCommandUnavailableReason = unavailableCommandGuidance;

export function resolveCanonicalCommandName(
  name: string,
  aliases: Readonly<Record<string, string>>,
  maxDepth = 8,
): string {
  const initial = normalizeCommandName(name);
  let current = initial;
  const seen = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (seen.has(current)) return initial;
    seen.add(current);
    const target = aliases[current]
      ?? aliases[`/${current}`]
      ?? Object.entries(aliases).find(([alias]) => normalizeCommandName(alias) === current)?.[1];
    if (!target) return current;
    const normalizedTarget = normalizeCommandName(target);
    if (!normalizedTarget || normalizedTarget === current) return current;
    current = normalizedTarget;
  }
  return current;
}

export function resolveCanonicalCommand(
  name: string,
  catalogOrAliases: NormalizedCommandCatalog | Readonly<Record<string, string>>,
): string {
  const normalizedCatalog = catalogOrAliases as Partial<NormalizedCommandCatalog>;
  const aliases: Readonly<Record<string, string>> = Array.isArray(normalizedCatalog.allCommands)
    ? normalizedCatalog.aliases ?? {}
    : catalogOrAliases as Readonly<Record<string, string>>;
  return resolveCanonicalCommandName(name, aliases);
}

function pairParts(pair: readonly unknown[]): { name: string; description: string } | null {
  const rawName = typeof pair[0] === "string" ? pair[0].trim() : "";
  const name = rawName.replace(/^\/+/, "");
  if (!name) return null;
  return {
    name,
    description: typeof pair[1] === "string" ? pair[1] : "",
  };
}

export function normalizeCommandCatalog(
  catalog: CommandCatalog | null | undefined,
  options: { locale?: string } | string = {},
): NormalizedCommandCatalog {
  const locale = typeof options === "string" ? options : options.locale ?? "fa";
  const pairByName = new Map<string, { name: string; description: string; order: number }>();
  const memberships = new Map<string, string[]>();
  const categoryNames = new Map<string, string>();
  const categoryOrder: string[] = [];
  let nextOrder = 0;

  const rememberPair = (pair: readonly unknown[]) => {
    const parsed = pairParts(pair);
    if (!parsed) return;
    const key = normalizeCommandName(parsed.name);
    const existing = pairByName.get(key);
    if (!existing) {
      pairByName.set(key, { ...parsed, order: nextOrder });
      nextOrder += 1;
    } else if (!existing.description && parsed.description) {
      existing.description = parsed.description;
    }
  };

  for (const pair of catalog?.pairs ?? []) rememberPair(pair);

  for (const category of catalog?.categories ?? []) {
    const rawCategory = category.name?.trim();
    if (!rawCategory) continue;
    const categoryKey = caseFold(rawCategory);
    if (!categoryNames.has(categoryKey)) {
      categoryNames.set(categoryKey, rawCategory);
      categoryOrder.push(categoryKey);
    }
    for (const pair of category.pairs ?? []) {
      rememberPair(pair);
      const parsed = pairParts(pair);
      if (!parsed) continue;
      const commandKey = normalizeCommandName(parsed.name);
      const commandMemberships = memberships.get(commandKey) ?? [];
      if (!commandMemberships.some((candidate) => caseFold(candidate) === categoryKey)) {
        commandMemberships.push(rawCategory);
        memberships.set(commandKey, commandMemberships);
      }
    }
  }

  const aliases: Record<string, string> = {};
  for (const [rawAlias, rawCanonical] of Object.entries(catalog?.canon ?? {})) {
    const alias = normalizeCommandName(rawAlias);
    const canonical = normalizeCommandName(rawCanonical);
    if (alias && canonical) aliases[alias] = canonical;
  }

  const subcommands: Record<string, string[]> = {};
  for (const [rawName, rawValues] of Object.entries(catalog?.sub ?? {})) {
    const name = normalizeCommandName(rawName);
    if (!name || !Array.isArray(rawValues)) continue;
    const seen = new Set<string>();
    subcommands[name] = rawValues.flatMap((value) => {
      if (typeof value !== "string") return [];
      const key = caseFold(value);
      if (seen.has(key)) return [];
      seen.add(key);
      return [value];
    });
  }

  const aliasesByCanonical = new Map<string, string[]>();
  for (const alias of Object.keys(aliases)) {
    const canonical = resolveCanonicalCommandName(alias, aliases);
    if (alias === canonical) continue;
    const values = aliasesByCanonical.get(canonical) ?? [];
    if (!values.includes(alias)) values.push(alias);
    aliasesByCanonical.set(canonical, values);
  }

  const orderedPairs = [...pairByName.entries()].sort((left, right) => left[1].order - right[1].order);
  const allCommands = orderedPairs.map(([key, pair]): WebCommandOption => {
    const commandMemberships = memberships.get(key) ?? [];
    // `/sessions` is advertised in both Session and TUI by current Hermes.
    // Prefer a usable category over a terminal-only duplicate regardless of order.
    const category = commandMemberships.find((candidate) => !categoryIsTerminalOnly(candidate))
      ?? commandMemberships[0]
      ?? SKILLS_CATEGORY;
    const canonicalName = resolveCanonicalCommandName(pair.name, aliases);
    const commandSubcommands = subcommands[canonicalName] ?? subcommands[key] ?? [];
    const source: WebCommandSource = category === SKILLS_CATEGORY
      ? "skill"
      : caseFold(category) === "user commands"
        ? "quick"
        : "builtin";

    return {
      name: pair.name,
      canonicalName,
      description: pair.description,
      ...(commandSubcommands.length
        ? { usage: `/${pair.name} ${commandSubcommands.join(" | ")}` }
        : {}),
      aliases: aliasesByCanonical.get(canonicalName) ?? [],
      subcommands: [...commandSubcommands],
      category,
      categoryLabel: localizeCommandCategory(category, locale),
      source,
      surface: commandSurface(canonicalName, category),
    };
  });

  const commands = allCommands.filter((command) => command.surface !== "unavailable");
  const groupKeys = [...categoryOrder];
  if (commands.some((command) => command.category === SKILLS_CATEGORY)) {
    groupKeys.push(caseFold(SKILLS_CATEGORY));
    categoryNames.set(caseFold(SKILLS_CATEGORY), SKILLS_CATEGORY);
  }
  const groups = groupKeys.flatMap((key): WebCommandGroup[] => {
    const name = categoryNames.get(key);
    if (!name) return [];
    const groupedCommands = commands.filter((command) => caseFold(command.category) === key);
    return groupedCommands.length
      ? [{ key, name, label: localizeCommandCategory(name, locale), commands: groupedCommands }]
      : [];
  });

  return {
    commands,
    allCommands,
    groups,
    aliases,
    subcommands,
    skillCount: catalog?.skillCount ?? 0,
    ...(catalog?.warning ? { warning: catalog.warning } : {}),
  };
}

export function findCommandOption(
  catalog: NormalizedCommandCatalog,
  name: string,
): WebCommandOption | undefined {
  const canonical = resolveCanonicalCommandName(name, catalog.aliases);
  return catalog.allCommands.find((command) => normalizeCommandName(command.canonicalName) === canonical);
}

type SearchableCommand = CommandOption & Partial<Pick<
  WebCommandOption,
  "aliases" | "canonicalName" | "category" | "categoryLabel" | "subcommands"
>>;

function commandSearchScore(command: SearchableCommand, needle: string, namesOnly: boolean): number | null {
  const name = normalizeCommandName(command.name);
  const canonical = normalizeCommandName(command.canonicalName ?? command.name);
  const aliases = (command.aliases ?? []).map(caseFold);
  if (name === needle || canonical === needle) return 0;
  if (name.startsWith(needle) || canonical.startsWith(needle)) return 1;
  if (aliases.some((alias) => alias === needle)) return 2;
  if (aliases.some((alias) => alias.startsWith(needle))) return 3;
  if (name.includes(needle) || canonical.includes(needle)) return 4;
  if (namesOnly) return null;
  const searchable = [
    command.description ?? "",
    command.category ?? "",
    command.categoryLabel ?? "",
    ...(command.subcommands ?? []),
  ].join(" ").toLocaleLowerCase();
  return searchable.includes(needle) ? 5 : null;
}

/** Shared stable filtering used by the inline menu and Cmd/Ctrl+K palette. */
export function filterCommandOptions<T extends CommandOption>(
  commands: readonly T[],
  query: string,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const trimmedQuery = query.trim();
  const needle = caseFold(trimmedQuery.replace(/^\//, ""));
  const namesOnly = trimmedQuery.startsWith("/");
  const cappedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : commands.length;
  if (!needle) return commands.slice(0, cappedLimit);

  return commands
    .map((command, index) => ({ command, index, score: commandSearchScore(command, needle, namesOnly) }))
    .filter((entry): entry is { command: T; index: number; score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, cappedLimit)
    .map((entry) => entry.command);
}

export function filterCommandGroups(
  groups: readonly WebCommandGroup[],
  query: string,
  limit = Number.POSITIVE_INFINITY,
): WebCommandGroup[] {
  const matches = filterCommandOptions(groups.flatMap((group) => group.commands), query, limit);
  const matchingNames = new Set(matches.map((command) => normalizeCommandName(command.name)));
  return groups.flatMap((group) => {
    const commands = group.commands.filter((command) => matchingNames.has(normalizeCommandName(command.name)));
    return commands.length ? [{ ...group, commands }] : [];
  });
}

function completionCommandName(value: string, replaceFrom: number, replacement: string): string | undefined {
  const nextValue = `${value.slice(0, replaceFrom)}${replacement}`;
  return parseSlashCommand(nextValue)?.normalizedName;
}

/**
 * Applies Hermes completions using its exact UTF-16 `replace_from` offset.
 * Hermes currently mixes slash-prefixed extras with slash-less registry items;
 * the only normalization here prevents `/` + `/logs` becoming `//logs`.
 */
export function normalizeSlashCompletions(
  value: string,
  result: SlashCompletionResult,
  catalog?: NormalizedCommandCatalog,
): NormalizedSlashCompletion[] {
  const replaceFrom = Math.max(0, Math.min(value.length, result.replaceFrom));
  const seen = new Set<string>();

  return result.items.flatMap((item, index) => {
    let replacement = item.text;
    if (replaceFrom > 0 && value[replaceFrom - 1] === "/" && replacement.startsWith("/")) {
      replacement = replacement.slice(1);
    }
    const commandName = completionCommandName(value, replaceFrom, replacement)
      ?? parseSlashCommand(value)?.normalizedName;
    const knownCommand = commandName && catalog ? findCommandOption(catalog, commandName) : undefined;
    if (
      (knownCommand && knownCommand.surface === "unavailable")
      || (commandName && isWebCommandUnavailable(commandName))
    ) {
      return [];
    }

    const nextValue = `${value.slice(0, replaceFrom)}${replacement}`;
    const dedupeKey = caseFold(nextValue);
    if (seen.has(dedupeKey)) return [];
    seen.add(dedupeKey);

    return [{
      id: `${replaceFrom}:${dedupeKey}:${index}`,
      text: replacement,
      display: item.display || replacement,
      description: item.meta,
      replaceFrom,
      value: nextValue,
      ...(commandName ? { commandName } : {}),
    }];
  });
}
