import AxeBuilder from "@axe-core/playwright";

import {expect, test} from "../fixtures/hermes-app";

const RESPONSIVE_WIDTHS = [
  320,
  360,
  479,
  481,
  639,
  641,
  671,
  673,
  831,
  833,
  959,
  961,
  1280,
  1440,
] as const;

for (const locale of ["fa", "en"] as const) {
  test(`${locale} compact shell keeps its geometry across supported widths`, async ({app, page}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "one browser covers the explicit geometry matrix");
    await page.setViewportSize({width: 1440, height: 900});
    await app.open(locale);
    await app.ensureSession();

    for (const width of RESPONSIVE_WIDTHS) {
      const height = width <= 481 ? 800 : 900;
      await page.setViewportSize({width, height});
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

      await app.expectNoPageOverflow();
      await expect(page.getByTestId("composer")).toBeInViewport();

      const geometry = await page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element || element.offsetParent === null) return null;
          const value = element.getBoundingClientRect();
          return {
            bottom: value.bottom,
            height: value.height,
            left: value.left,
            right: value.right,
            top: value.top,
            width: value.width,
          };
        };
        return {
          chatHeader: rect(".chat-header"),
          composer: rect(".composer"),
          send: rect('[data-testid="send-message"]'),
          workspaceTrigger: rect(".workspace-nav__mobile-trigger"),
          viewport: {height: window.innerHeight, width: window.innerWidth},
        };
      });

      expect(geometry.chatHeader, `chat header at ${width}px`).not.toBeNull();
      expect(geometry.composer, `composer at ${width}px`).not.toBeNull();
      expect(geometry.send, `send control at ${width}px`).not.toBeNull();
      expect(geometry.chatHeader!.height, `header height at ${width}px`).toBeLessThanOrEqual(48.5);
      expect(geometry.composer!.left, `composer left edge at ${width}px`).toBeGreaterThanOrEqual(-0.5);
      expect(geometry.composer!.right, `composer right edge at ${width}px`).toBeLessThanOrEqual(width + 0.5);
      expect(geometry.composer!.bottom, `composer bottom edge at ${width}px`).toBeLessThanOrEqual(height + 0.5);

      if (width <= 671) {
        expect(geometry.send!.height, `mobile target at ${width}px`).toBeGreaterThanOrEqual(43.5);
        expect(geometry.send!.width, `mobile target width at ${width}px`).toBeGreaterThanOrEqual(43.5);
      } else {
        expect(geometry.send!.height, `desktop control at ${width}px`).toBeGreaterThanOrEqual(31.5);
        expect(geometry.send!.height, `desktop control at ${width}px`).toBeLessThanOrEqual(36.5);
      }

      if (geometry.workspaceTrigger) {
        expect(geometry.workspaceTrigger.height, `mobile navigation target at ${width}px`).toBeGreaterThanOrEqual(43.5);
        expect(geometry.workspaceTrigger.bottom, `navigation trigger at ${width}px`).toBeLessThanOrEqual(
          geometry.chatHeader!.bottom + 0.5,
        );
      }
    }
  });
}

test("compact desktop and mobile interaction states remain axe-clean", async ({app, page}, testInfo) => {
  await app.open("fa");
  await app.ensureSession();

  if (testInfo.project.name === "chromium") {
    const railToggle = page.getByTestId("session-rail-toggle");
    if (await railToggle.isVisible()) await railToggle.click();
  } else {
    const sessionsTrigger = page.getByRole("button", {name: /بازکردن فهرست گفت‌وگوها/u});
    if (await sessionsTrigger.isVisible()) await sessionsTrigger.click();
  }

  const result = await new AxeBuilder({page})
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations).toEqual([]);
});
