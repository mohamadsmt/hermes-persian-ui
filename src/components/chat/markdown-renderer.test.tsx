import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {NextIntlClientProvider} from "next-intl";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import messages from "@/messages/fa.json";

import {MarkdownRenderer} from "./markdown-renderer";

function renderMarkdown(source: string) {
  return render(
    <NextIntlClientProvider locale="fa" messages={messages} timeZone="Asia/Tehran">
      <MarkdownRenderer source={source} />
    </NextIntlClientProvider>,
  );
}

describe("MarkdownRenderer", () => {
  const writeText = vi.fn<(value: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {writeText},
    });
  });

  afterEach(cleanup);

  it("gives every prose block independent native direction and inline isolation", () => {
    const source = [
      "لطفاً فایل src/components/Chat.tsx را با React بررسی کن.",
      "",
      "Use مدل claude-sonnet-4.6 برای this task.",
    ].join("\n");

    renderMarkdown(source);

    const blocks = screen.getAllByTestId("bidi-block");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.getAttribute("dir") === "auto")).toBe(true);
    expect(blocks.map((block) => block.textContent).join("\n\n")).toBe(source);
    expect(document.querySelector("bdi.technical-inline")).toBeInTheDocument();
  });

  it("keeps fenced code LTR and copies its unmodified source", async () => {
    const source = "متن فارسی پیش از کد.\n\n```ts title=client.ts\nconst endpoint = '/v1/responses';\n```\n\nمتن فارسی پس از کد.";

    renderMarkdown(source);

    const codeBlock = screen.getByTestId("code-block");
    expect(codeBlock).toHaveAttribute("dir", "ltr");
    expect(codeBlock).toHaveAttribute("data-wrap", "false");
    expect(codeBlock).toHaveAttribute("data-has-filename", "true");
    expect(codeBlock).toHaveTextContent("client.ts");
    expect(codeBlock.querySelector(".markdown-code-metadata")).toHaveTextContent("ts·client.ts");

    fireEvent.click(screen.getByTestId("copy-code"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("const endpoint = '/v1/responses';"),
    );
  });

  it("copies the exact Markdown source rather than rendered DOM text", async () => {
    const source = "قیمت برابر **$1,250** است (با 20% تخفیف).";

    renderMarkdown(source);
    fireEvent.click(screen.getByTestId("copy-message"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
  });
});
