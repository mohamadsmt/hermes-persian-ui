import { describe, expect, it } from "vitest";

import {
  BIDI_FIXTURES,
  BIDI_MARKDOWN,
  DIRECTION_CONTROL_CHARACTER,
} from "./bidi";

describe("canonical BiDi regression corpus", () => {
  it("keeps the six verbatim brief samples and ten unique cases", () => {
    expect(BIDI_FIXTURES).toHaveLength(10);
    expect(new Set(BIDI_FIXTURES.map(({ id }) => id)).size).toBe(10);
    expect(BIDI_FIXTURES.slice(0, 6).map(({ source }) => source)).toEqual([
      "امروز endpoint جدید /v1/responses را تست کردم و status برابر 200 بود.",
      "لطفاً فایل src/components/Chat.tsx را با React بررسی کن.",
      "برای اجرا از npm run build استفاده کن و نتیجه را در README.md بنویس.",
      "Use مدل claude-sonnet-4.6 برای این task و پاسخ را فارسی بنویس.",
      "قیمت برابر $1,250 است (با 20% تخفیف).",
      "خطای TypeError: Cannot read properties of undefined در تابع getSession رخ داده است.",
    ]);
  });

  it("never stores directional control characters in logical source", () => {
    for (const { source } of BIDI_FIXTURES) {
      expect(source).not.toMatch(DIRECTION_CONTROL_CHARACTER);
    }
  });

  it("preserves punctuation and technical identifiers in the joined fixture", () => {
    expect(BIDI_MARKDOWN).toContain("/v1/responses");
    expect(BIDI_MARKDOWN).toContain("src/components/Chat.tsx");
    expect(BIDI_MARKDOWN).toContain("TypeError:");
    expect(BIDI_MARKDOWN).toContain("$1,250");
    expect(BIDI_MARKDOWN).toContain("20%");
    expect(BIDI_MARKDOWN).toContain("claude-sonnet-4.6");
    expect(BIDI_MARKDOWN).toContain("https://hermes.nousresearch.com/docs");
    expect(BIDI_MARKDOWN).toContain('const endpoint = "/v1/responses";');
  });
});
