import { expect, test } from "../fixtures/hermes-app";

test("shows web commands and dynamic skills while hiding terminal-only commands", async ({
  app,
  page,
}) => {
  await app.open();
  await app.ensureSession();
  await app.composer.fill("/");

  const menu = page.getByRole("listbox", { name: /فرمان‌های هرمس|Hermes commands/iu });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("option").filter({ hasText: "/help" })).toBeVisible();
  await expect(menu.getByRole("option").filter({ hasText: "/skill-test" })).toBeVisible();
  await expect(menu.locator("bdi", { hasText: "/logs" })).toHaveCount(0);
  await expect(menu.locator("bdi", { hasText: "/redraw" })).toHaveCount(0);

  await app.composer.fill("/help ");
  await app.composer.press("Enter");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await expect(page.getByTestId("command-palette")).toContainText("skill-test");
  await expect(page.getByTestId("command-palette")).not.toContainText("/logs");
  await page.keyboard.press("Escape");

  await app.composer.fill("/logs ");
  await app.composer.press("Enter");
  await expect(app.messages("system").last()).toContainText("مخصوص ترمینال");
});

test("executes output and skill directives and applies undo prefill", async ({ app }) => {
  await app.open();
  await app.ensureSession();

  await app.composer.fill("/version ");
  await app.composer.press("Enter");
  await expect(app.messages("system").last()).toContainText("Hermes Agent v0.18.2-test");

  await app.composer.fill("/skill-test review this ");
  await app.composer.press("Enter");
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
  await expect(app.messages("user").last()).toContainText("Use the dynamically discovered Test Skill");

  await app.send("prompt restored by undo");
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
  await app.composer.fill("/undo ");
  await app.composer.press("Enter");
  await expect(app.composer).toHaveValue("prompt restored by undo");
  await expect(app.messages("system").last()).toContainText("Undid 1 turn");
});

test("opens the active-profile session picker from slash", async ({ app, page }) => {
  await app.open();
  await app.ensureSession();
  await app.composer.fill("/sessions ");
  await app.composer.press("Enter");

  const mobile = (page.viewportSize()?.width ?? 0) <= 480;
  if (mobile) {
    await expect(page.locator(".session-rail")).toHaveClass(/session-rail--mobile-open/u);
  } else {
    await expect(page.getByTestId("new-session")).toBeInViewport();
  }
});

test("keeps the selected provider when completing a model command", async ({ app, page }) => {
  await app.open();
  await app.ensureSession();
  await app.composer.fill("/model cla");
  const option = page
    .getByRole("listbox", { name: /فرمان‌های هرمس|Hermes commands/iu })
    .getByRole("option", { name: /claude-sonnet-4\.6/iu });
  await expect(option).toBeVisible();
  await app.composer.press("Tab");
  await expect(app.composer).toHaveValue("/model claude-sonnet-4.6 --provider anthropic");
  await app.composer.press("Enter");
  await app.openComposerSettings();
  await expect(page.getByTestId("model-picker")).toHaveValue("anthropic:claude-sonnet-4.6");
});

test("keeps slash-prefixed queued text as a prompt", async ({ app, page }) => {
  await app.open();
  await app.ensureSession();
  await app.composer.fill("/queue /help me ");
  await app.composer.press("Enter");

  await expect(app.messages("user").last()).toContainText("/help me");
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("command-palette")).toBeHidden();
});

test("opens Knowledge for a Journey alias without relying on catalog lookup", async ({ app, page }) => {
  await app.open();
  await app.ensureSession();
  await app.composer.fill("/learning ");
  await app.composer.press("Enter");
  await expect(page).toHaveURL(/\/(?:fa|en)\/knowledge\/?$/u);
});
