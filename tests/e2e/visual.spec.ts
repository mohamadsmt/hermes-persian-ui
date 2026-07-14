import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/hermes-app";

const FIXED_VISUAL_TIME = new Date("2026-07-13T13:30:00.000Z");

async function waitForSyntaxHighlight(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page
          .locator('[data-streamdown="code-block-body"] span[style*="--sdm-c"]')
          .evaluateAll((tokens) =>
            tokens.some((token) => {
              const parent = token.parentElement;
              if (!parent) return false;
              return getComputedStyle(token).color !== getComputedStyle(parent).color;
            }),
          ),
      { timeout: 10_000 },
    )
    .toBe(true);

  // Shiki first exposes token variables and then applies its theme stylesheet.
  // Let the computed token colors survive two paints before capturing pixels.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

test("desktop RTL light with mixed BiDi content @visual", async ({ app, page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop baseline");
  await page.clock.setFixedTime(FIXED_VISUAL_TIME);
  await app.open();
  await app.sendScenario("bidi");
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
  await app.expectNoPageOverflow();
  await waitForSyntaxHighlight(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page).toHaveScreenshot("desktop-rtl-light.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
  });
});

test("desktop RTL dark tool and approval states @visual", async ({ app, page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop baseline");
  await page.clock.setFixedTime(FIXED_VISUAL_TIME);
  await app.open();
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveClass(/dark/u);
  await app.sendScenario("tool");
  await expect(page.getByTestId("tool-card").last()).toHaveAttribute("data-status", "complete");
  await app.sendScenario("approval");
  await expect(page.getByTestId("approval-dialog")).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page).toHaveScreenshot("desktop-rtl-dark-approval.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
  });
});

test("desktop RTL running tool with artifact preview @visual", async ({ app, page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop baseline");
  await page.clock.setFixedTime(FIXED_VISUAL_TIME);
  await app.open();
  await app.sendScenario("toolRunningArtifact");

  const tool = page.getByTestId("tool-card").last();
  await expect(tool).toHaveAttribute("data-status", "running");
  await expect(tool.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
  // A real artifact event opens the desktop preview rail automatically.
  await expect(page.getByTestId("artifact-rail")).toBeVisible();
  await expect(page.getByTestId("artifact-rail")).toContainText("report.ts");
  await waitForSyntaxHighlight(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  try {
    await expect(page).toHaveScreenshot("desktop-rtl-tool-running-artifact.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  } finally {
    const stop = page.getByTestId("stop-run");
    if (await stop.isVisible()) await stop.click();
  }
});

test("mobile RTL composer and technical content @visual", async ({ app, page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile baseline");
  await page.clock.setFixedTime(FIXED_VISUAL_TIME);
  await app.open();
  await app.sendScenario("bidi");
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
  await app.expectNoPageOverflow();
  await waitForSyntaxHighlight(page);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page).toHaveScreenshot("mobile-rtl-bidi.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
  });
});
