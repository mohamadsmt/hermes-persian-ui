import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";

import {BidiBlock, getLogicalText, isolateInlineContent} from "./bidi-text";

describe("BiDi text primitives", () => {
  it("uses native per-block direction without adding control characters", () => {
    const source = "امروز endpoint جدید /v1/responses را تست کردم و status برابر 200 بود.";

    render(<BidiBlock as="p">{source}</BidiBlock>);

    const block = screen.getByTestId("bidi-block");
    expect(block).toHaveAttribute("dir", "auto");
    expect(block).toHaveClass("bidi-block");
    expect(block.textContent).toBe(source);
    expect(block.textContent).not.toMatch(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });

  it("isolates complete technical runs while preserving logical text", () => {
    const source = "خطای TypeError: Cannot read properties of undefined در getSession رخ داد.";
    const isolated = isolateInlineContent(source);

    const {container} = render(<p>{isolated}</p>);
    const islands = [...container.querySelectorAll("bdi[dir='ltr']")];

    expect(islands.map((element) => element.textContent)).toContain(
      "TypeError: Cannot read properties of undefined",
    );
    expect(container.textContent).toBe(source);
  });

  it("extracts unchanged logical text from nested React content", () => {
    expect(getLogicalText(["npm ", <strong key="command">run build</strong>, "\n"])).toBe(
      "npm run build\n",
    );
  });
});

