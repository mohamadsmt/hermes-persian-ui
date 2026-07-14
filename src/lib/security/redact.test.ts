import { describe, expect, it } from "vitest";

import { redactSensitive, safeJson } from "./redact";

describe("tool output redaction", () => {
  it("redacts nested credentials without mutating ordinary technical values", () => {
    const source = {
      command: "curl /v1/responses",
      headers: { Authorization: "Bearer private", "x-api-key": "sk-test" },
      nested: [{ password: "correct horse", model: "gpt-5.6-sol" }],
    };

    expect(redactSensitive(source)).toEqual({
      command: "curl /v1/responses",
      headers: { Authorization: "[REDACTED]", "x-api-key": "[REDACTED]" },
      nested: [{ password: "[REDACTED]", model: "gpt-5.6-sol" }],
    });
    expect(source.headers.Authorization).toBe("Bearer private");
  });

  it("bounds very large and recursive-looking output", () => {
    const serialized = safeJson({ output: "x".repeat(25_000) });
    expect(serialized).toContain("[TRUNCATED]");
    expect(serialized.length).toBeLessThan(21_000);
  });
});

