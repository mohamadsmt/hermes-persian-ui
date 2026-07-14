export type BidiFixtureKind =
  | "mixed-line"
  | "markdown-list"
  | "mixed-paragraphs"
  | "markdown-link"
  | "fenced-code";

export interface BidiFixture {
  readonly id: string;
  readonly kind: BidiFixtureKind;
  /** Exact logical source. This is also the expected clipboard value. */
  readonly source: string;
}

/**
 * Canonical BiDi regression corpus from the product brief.
 *
 * Cases 1-6 are copied byte-for-byte from the brief. The brief describes
 * cases 7-10 structurally rather than prescribing their wording, so their
 * Markdown below is the canonical wording used by every test and screenshot.
 * Never inject direction-control characters into these strings.
 */
export const BIDI_FIXTURES = [
  {
    id: "endpoint-status",
    kind: "mixed-line",
    source: "امروز endpoint جدید /v1/responses را تست کردم و status برابر 200 بود.",
  },
  {
    id: "tsx-path",
    kind: "mixed-line",
    source: "لطفاً فایل src/components/Chat.tsx را با React بررسی کن.",
  },
  {
    id: "npm-readme",
    kind: "mixed-line",
    source: "برای اجرا از npm run build استفاده کن و نتیجه را در README.md بنویس.",
  },
  {
    id: "english-leading-model",
    kind: "mixed-line",
    source: "Use مدل claude-sonnet-4.6 برای این task و پاسخ را فارسی بنویس.",
  },
  {
    id: "currency-percent",
    kind: "mixed-line",
    source: "قیمت برابر $1,250 است (با 20% تخفیف).",
  },
  {
    id: "typescript-error",
    kind: "mixed-line",
    source:
      "خطای TypeError: Cannot read properties of undefined در تابع getSession رخ داده است.",
  },
  {
    id: "persian-list-with-filenames",
    kind: "markdown-list",
    source:
      "- فایل `src/components/Chat.tsx` را بررسی کن.\n- سپس `README.md` را به‌روزرسانی کن.",
  },
  {
    id: "independent-paragraph-direction",
    kind: "mixed-paragraphs",
    source:
      "این پاراگراف فارسی است و جهت آن باید راست‌به‌چپ باشد.\n\nThis English paragraph must remain left-to-right, even after Persian prose.",
  },
  {
    id: "persian-link-latin-url",
    kind: "markdown-link",
    source: "[مستندات Hermes](https://hermes.nousresearch.com/docs)",
  },
  {
    id: "code-between-rtl-paragraphs",
    kind: "fenced-code",
    source:
      "پیش از اجرا، endpoint را بررسی کن.\n\n```ts\nconst endpoint = \"/v1/responses\";\nconsole.log(endpoint);\n```\n\nپس از اجرا، نتیجه را به فارسی توضیح بده.",
  },
] as const satisfies readonly BidiFixture[];

export const BIDI_MARKDOWN = BIDI_FIXTURES.map(({ source }) => source).join(
  "\n\n---\n\n",
);

export const DIRECTION_CONTROL_CHARACTER = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
