import type { Page } from "@playwright/test";

import {
  expect,
  test,
  TEST_SCENARIOS,
  type HermesApp,
} from "../fixtures/hermes-app";

const FIXED_VISUAL_TIME = new Date("2026-07-13T13:30:00.000Z");

type WorkspaceModule = "activity" | "automations" | "knowledge" | "settings";

const WORKSPACE_MODULE_TITLES = {
  activity: {en: "Activity", fa: "فعالیت‌ها"},
  automations: {en: "Automations", fa: "خودکارسازی‌ها"},
  knowledge: {en: "Knowledge", fa: "دانش"},
  settings: {en: "Settings", fa: "تنظیمات"},
} as const;

async function settleVisualPage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function settleSlashVisual(page: Page): Promise<void> {
  // The partially obscured empty-state SVG can rasterize a handful of pixels
  // differently under parallel Chromium load. It is outside the slash surface.
  await page.addStyleTag({
    content: ".transcript-empty__icon { visibility: hidden !important; }",
  });
  await settleVisualPage(page);
}

async function openWorkspaceModule(
  page: Page,
  locale: "en" | "fa",
  workspaceModule: WorkspaceModule,
): Promise<void> {
  const mobileTrigger = page.locator(".workspace-nav__mobile-trigger");
  if (await mobileTrigger.isVisible()) {
    if ((await mobileTrigger.getAttribute("aria-expanded")) !== "true") {
      await mobileTrigger.click();
    }
    await expect(mobileTrigger).toHaveAttribute("aria-expanded", "true");
  }
  await page.locator(`a[href="/${locale}/${workspaceModule}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/${locale}/${workspaceModule}/?$`, "u"));
  await expect(
    page.getByRole("heading", {
      name: WORKSPACE_MODULE_TITLES[workspaceModule][locale],
      exact: true,
    }),
  ).toBeVisible();
}

async function prepareWorkspaceActivity(
  page: Page,
  app: HermesApp,
  locale: "en" | "fa",
): Promise<void> {
  await app.open(locale);
  await app.ensureSession();
  // Re-enter through the canonical profile-owned URL so Activity always
  // starts from the same durable resume state as a returning workspace.
  await page.reload();
  await expect(app.shell).toBeVisible();
  await expect(app.connectionStatus).toHaveText(/^(?:متصل|Connected)$/iu, {timeout: 15_000});
  await expect(app.composer).toBeEnabled();
  if ((page.viewportSize()?.width ?? 0) <= 480) {
    const previousUserMessageCount = await app.messages("user").count();
    await app.composer.fill(TEST_SCENARIOS.tool);
    // The fixed mobile workspace nav shares the bottom edge with the composer.
    // Keyboard submission keeps this visual setup independent of pointer overlap.
    await app.composer.press("Enter");
    await expect(app.messages("user")).toHaveCount(previousUserMessageCount + 1);
  } else {
    await app.sendScenario("tool");
  }
  await expect(page.getByTestId("tool-card").last()).toHaveAttribute("data-status", "complete");
  await openWorkspaceModule(page, locale, "activity");
  await expect(page.getByText("terminal", {exact: true}).first()).toBeVisible();
}

async function prepareWorkspaceAutomations(
  page: Page,
  app: HermesApp,
  locale: "en" | "fa",
): Promise<void> {
  await app.open(locale);
  const listResponse = page.waitForResponse((response) =>
    /\/api\/hermes\/automations\?profile=/u.test(response.url()),
  );
  await openWorkspaceModule(page, locale, "automations");
  expect((await listResponse).ok()).toBe(true);
  await expect(page.getByText("Workspace daily brief", {exact: true})).toBeVisible();

  const runsResponse = page.waitForResponse((response) =>
    /\/api\/hermes\/automations\/workspace-daily\/runs\?profile=/u.test(response.url()),
  );
  const outputsResponse = page.waitForResponse((response) =>
    /\/api\/hermes\/automations\/workspace-daily\/outputs\?profile=/u.test(response.url()),
  );
  await page.getByRole("button", {name: locale === "fa" ? "جزئیات" : "Details"}).click();
  expect((await runsResponse).ok()).toBe(true);
  expect((await outputsResponse).ok()).toBe(true);
  await expect(page.getByText("2026-07-15.md", {exact: true})).toBeVisible();
}

async function prepareWorkspaceKnowledge(
  page: Page,
  app: HermesApp,
  locale: "en" | "fa",
): Promise<void> {
  await app.open(locale);
  const timelineResponse = page.waitForResponse((response) =>
    /\/api\/hermes\/learning\/timeline\?profile=/u.test(response.url()),
  );
  const pendingResponse = page.waitForResponse((response) =>
    /\/api\/hermes\/learning\/pending\?profile=/u.test(response.url()),
  );
  await openWorkspaceModule(page, locale, "knowledge");
  expect((await timelineResponse).ok()).toBe(true);
  expect((await pendingResponse).ok()).toBe(true);
  await expect(page.getByText("Workspace conventions", {exact: true})).toBeVisible();
  await expect(page.getByText("memory-test", {exact: true})).toBeVisible();
}

async function prepareWorkspaceSettings(
  page: Page,
  app: HermesApp,
  locale: "en" | "fa",
): Promise<void> {
  await app.open(locale);
  await openWorkspaceModule(page, locale, "settings");
  await expect(
    page.getByRole("heading", {
      name: locale === "fa" ? "ظاهر" : "Appearance",
      level: 2,
    }),
  ).toBeVisible();
}

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

for (const locale of ["fa", "en"] as const) {
  test(`desktop ${locale === "fa" ? "RTL" : "LTR"} slash command menu @visual`, async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "desktop slash baseline");
    await page.clock.setFixedTime(FIXED_VISUAL_TIME);
    await app.open(locale);
    await app.ensureSession();
    await app.composer.fill("/");
    await expect(page.getByRole("listbox", { name: /فرمان‌های هرمس|Hermes commands/iu })).toBeVisible();
    await settleSlashVisual(page);
    await expect(page).toHaveScreenshot(`desktop-${locale === "fa" ? "rtl" : "ltr"}-slash-menu.png`, {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  });

  test(`mobile ${locale === "fa" ? "RTL" : "LTR"} slash command menu @visual`, async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile slash baseline");
    await page.clock.setFixedTime(FIXED_VISUAL_TIME);
    await app.open(locale);
    await app.ensureSession();
    await app.composer.fill("/");
    await expect(page.getByRole("listbox", { name: /فرمان‌های هرمس|Hermes commands/iu })).toBeVisible();
    await settleSlashVisual(page);
    await expect(page).toHaveScreenshot(`mobile-${locale === "fa" ? "rtl" : "ltr"}-slash-menu.png`, {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  });
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
  await page.getByTestId("header-more-trigger").click();
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

test("tablet RTL empty chat with conversation drawer @visual", async ({ app, page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "tablet baseline");
  await page.setViewportSize({ width: 820, height: 900 });
  await page.clock.setFixedTime(FIXED_VISUAL_TIME);
  await app.open("fa");
  await app.ensureSession();
  await app.openSessionRail();
  await app.expectNoPageOverflow();
  await settleVisualPage(page);
  await expect(page).toHaveScreenshot("tablet-820x900-rtl-session-drawer.png", {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
  });
});

test("wide RTL pinned artifact inspector @visual", async ({ app, page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "wide desktop baseline");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.setFixedTime(FIXED_VISUAL_TIME);
  await app.open("fa");
  await app.sendScenario("toolRunningArtifact");
  await expect(page.getByTestId("artifact-rail")).toBeVisible();
  await page.getByTestId("artifact-rail").getByRole("button", {
    name: /سنجاق‌کردن پنل جزئیات|Pin inspector/iu,
  }).click();
  await expect(app.shell).toHaveAttribute("data-inspector-pinned", "true");
  await waitForSyntaxHighlight(page);
  await app.expectNoPageOverflow();
  await settleVisualPage(page);
  try {
    await expect(page).toHaveScreenshot("wide-1440x900-rtl-pinned-inspector.png", {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  } finally {
    const stop = page.getByTestId("stop-run");
    if (await stop.isVisible()) await stop.click();
  }
});

for (const workspaceModule of ["activity", "automations", "knowledge", "settings"] as const) {
  test(`desktop Persian ${workspaceModule} workspace @visual`, async ({app, page}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "desktop workspace baseline");
    await page.clock.setFixedTime(FIXED_VISUAL_TIME);

    if (workspaceModule === "activity") await prepareWorkspaceActivity(page, app, "fa");
    if (workspaceModule === "automations") await prepareWorkspaceAutomations(page, app, "fa");
    if (workspaceModule === "knowledge") await prepareWorkspaceKnowledge(page, app, "fa");
    if (workspaceModule === "settings") await prepareWorkspaceSettings(page, app, "fa");

    await app.expectNoPageOverflow();
    await settleVisualPage(page);
    await expect(page).toHaveScreenshot(`workspace-${workspaceModule}-fa-desktop.png`, {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  });

  test(`mobile English ${workspaceModule} workspace @visual`, async ({app, page}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile workspace baseline");
    await page.clock.setFixedTime(FIXED_VISUAL_TIME);

    if (workspaceModule === "activity") await prepareWorkspaceActivity(page, app, "en");
    if (workspaceModule === "automations") await prepareWorkspaceAutomations(page, app, "en");
    if (workspaceModule === "knowledge") await prepareWorkspaceKnowledge(page, app, "en");
    if (workspaceModule === "settings") await prepareWorkspaceSettings(page, app, "en");

    await app.expectNoPageOverflow();
    await settleVisualPage(page);
    await expect(page).toHaveScreenshot(`workspace-${workspaceModule}-en-mobile.png`, {
      animations: "disabled",
      caret: "hide",
      fullPage: true,
    });
  });
}
