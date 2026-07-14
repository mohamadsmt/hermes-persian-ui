const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)/i;

const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 20_000;

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(child, depth + 1),
      ]),
    );
  }
  return value;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(redactSensitive(value), null, 2);
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

export const __testing = { SENSITIVE_KEY, MAX_DEPTH, MAX_STRING_LENGTH };
