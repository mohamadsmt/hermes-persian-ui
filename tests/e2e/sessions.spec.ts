import { expect, test } from "../fixtures/hermes-app";

test("the session-list BFF requires one concrete profile", async ({ app, page }) => {
  await app.open();
  const [missing, aggregate, duplicate] = await Promise.all([
    page.request.get("/api/hermes/sessions"),
    page.request.get("/api/hermes/sessions?profile=all"),
    page.request.get("/api/hermes/sessions?profile=default&profile=research"),
  ]);

  expect([missing.status(), aggregate.status(), duplicate.status()]).toEqual([400, 400, 400]);
});

test("creates multiple sessions and resumes the first by its stable stored id", async ({
  app,
  page,
}) => {
  await app.open();
  await app.ensureSession();
  const firstStoredId = new URL(page.url()).pathname.split("/").at(-1);
  expect(firstStoredId).toBeTruthy();
  await app.send("جلسهٔ اول");

  await app.createSession();
  const secondStoredId = new URL(page.url()).pathname.split("/").at(-1);
  expect(secondStoredId).not.toBe(firstStoredId);

  await app.openSessionRail();
  const firstSession = page.locator(
    `[data-testid="session-item"][data-session-id="${firstStoredId}"]`,
  );
  await expect(firstSession).toBeVisible();
  await firstSession.click();
  await expect(page).toHaveURL(new RegExp(`/(?:fa|en)/c/${firstStoredId}\\?profile=default$`, "u"));
  await expect(app.messages("user").last()).toContainText("جلسهٔ اول");
});

test("does not offer deletion for a session active in another runtime", async ({ app, page }) => {
  await app.open();
  await app.ensureSession();
  const firstStoredId = new URL(page.url()).pathname.split("/").at(-1);
  await app.createSession();
  const currentStoredId = new URL(page.url()).pathname.split("/").at(-1);
  await app.openSessionRail();

  const otherActive = page.locator(
    `[data-testid="session-item"][data-session-id="${firstStoredId}"]`,
  );
  await otherActive.getByTestId("session-actions").click();
  await expect(otherActive.getByTestId("rename-session")).toBeVisible();
  await expect(otherActive.getByTestId("delete-session")).toHaveCount(0);
  await otherActive.getByTestId("session-actions").click();

  const current = page.locator(
    `[data-testid="session-item"][data-session-id="${currentStoredId}"]`,
  );
  await current.getByTestId("session-actions").click();
  await expect(current.getByTestId("delete-session")).toBeVisible();
});

test("model changes are scoped to one session", async ({ app, page }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "model picker is intentionally desktop-only");
  await app.open();
  await app.ensureSession();

  const picker = page.getByTestId("model-picker");
  await expect(picker).toHaveValue("openai-codex:gpt-5.6-sol");

  if ((await picker.evaluate((element) => element.tagName)) === "SELECT") {
    await picker.selectOption("anthropic:claude-sonnet-4.6");
  } else {
    await picker.click();
    await page.getByRole("option", { name: /claude-sonnet-4\.6/u }).click();
  }
  await expect(picker).toHaveValue("anthropic:claude-sonnet-4.6");

  await app.createSession();
  await expect(page.getByTestId("model-picker")).toHaveValue("openai-codex:gpt-5.6-sol");
});

test("reasoning inherits Ultra and preserves a per-session High override", async ({
  app,
  page,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "reasoning picker is intentionally desktop-only");
  await app.open();
  await expect(page.getByTestId("reasoning-picker")).toHaveValue("");
  await expect(page.getByTestId("reasoning-picker")).toBeDisabled();
  await app.ensureSession();
  const firstStoredId = new URL(page.url()).pathname.split("/").at(-1);
  expect(firstStoredId).toBeTruthy();

  const picker = page.getByTestId("reasoning-picker");
  await expect(picker).toHaveValue("ultra");
  await picker.selectOption("high");
  await expect(picker).toHaveValue("high");

  await app.createSession();
  await expect(page.getByTestId("reasoning-picker")).toHaveValue("ultra");

  await app.openSessionRail();
  await page.locator(
    `[data-testid="session-item"][data-session-id="${firstStoredId}"] .session-row__main`,
  ).click();
  await expect(page).toHaveURL(new RegExp(`/(?:fa|en)/c/${firstStoredId}\\?profile=default$`, "u"));
  await expect(page.getByTestId("reasoning-picker")).toHaveValue("high");
});

test("renames, searches, and explicitly confirms deletion", async ({ app, page }) => {
  await app.open();
  await app.ensureSession();
  await app.openSessionRail();
  const storedId = new URL(page.url()).pathname.split("/").at(-1);
  const session = page.locator(
    `[data-testid="session-item"][data-session-id="${storedId}"]`,
  );

  await session.getByTestId("session-actions").click();
  await session.getByTestId("rename-session").click();
  const title = page.getByTestId("session-title");
  await title.fill("جلسهٔ آزمون پایدار");
  await title.press("Enter");
  await expect(session).toContainText("جلسهٔ آزمون پایدار");

  await page.getByTestId("session-search").fill("پایدار");
  await expect(page.locator('[data-testid="session-item"]:visible')).toHaveCount(1);
  await page.getByTestId("session-search").fill("");

  await session.getByTestId("session-actions").click();
  await session.getByTestId("delete-session").click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByTestId("confirm-delete").click();
  await expect(session).toHaveCount(0);
});

test("shows live usage and closes a runtime session without deleting its history", async ({ app, page }) => {
  await app.open();
  await app.ensureSession();
  const storedId = new URL(page.url()).pathname.split("/").at(-1);
  expect(storedId).toBeTruthy();
  await app.send("برای مصرف یک پاسخ کوتاه بده");
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");

  await app.openSessionRail();
  const session = page.locator(
    `[data-testid="session-item"][data-session-id="${storedId}"]`,
  );
  await session.getByTestId("session-actions").click();
  await session.getByTestId("session-usage").click();
  const usage = page.getByTestId("usage-dialog");
  await expect(usage).toBeVisible();
  await expect(usage).toContainText(/مجموع توکن‌ها|Total tokens/iu);
  await expect(usage).toContainText(/30|۳۰/u);
  await usage.getByRole("button", { name: /بستن|Close/iu }).click();

  await session.getByTestId("session-actions").click();
  await session.getByTestId("close-session").click();
  await page.getByTestId("confirm-close").click();
  await expect(page).toHaveURL(/\/(?:fa|en)\?profile=default$/u);
  await expect(session).toHaveCount(1);

  await session.locator(".session-row__main").click();
  await expect(page).toHaveURL(new RegExp(`/(?:fa|en)/c/${storedId}\\?profile=default$`, "u"));
  await expect(app.messages("user").last()).toContainText("برای مصرف یک پاسخ کوتاه بده");
});
