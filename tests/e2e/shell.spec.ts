import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "../fixtures/hermes-app";

test("Persian is the default locale and the shell is keyboard accessible", async ({
  app,
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/fa(?:\/|$)/u);
  await expect(page.locator("html")).toHaveAttribute("lang", "fa");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(app.shell).toBeVisible();

  await app.ensureSession();
  await app.composer.focus();
  await page.keyboard.press("Control+K");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();

  await app.expectNoPageOverflow();
});

test("English locale changes the document language and direction", async ({ app, page }) => {
  await app.open("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await app.expectNoPageOverflow();
});

test("the primary Persian shell has no serious WCAG A/AA violations", async ({ app, page }) => {
  await app.open("fa");
  await app.ensureSession();

  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();

  expect(result.violations).toEqual([]);
});

test("mobile shell has no horizontal page overflow", async ({ app, page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-project assertion");
  await app.open("fa");
  await app.ensureSession();
  await expect(page.getByTestId("composer")).toBeInViewport();
  await app.expectNoPageOverflow();
});
