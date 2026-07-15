import { expect, test } from "../fixtures/hermes-app";

test("keeps the active stream alive while navigating through Activity", async ({ app, page }) => {
  await app.open("fa");
  await app.sendScenario("slow");
  const storedId = new URL(page.url()).pathname.split("/").at(-1);
  expect(storedId).toBeTruthy();
  await expect(page.getByTestId("stop-run")).toBeVisible();

  await page.getByRole("link", { name: "فعالیت‌ها" }).click();
  await expect(page).toHaveURL(/\/fa\/activity$/u);
  await expect(page.getByRole("heading", { name: "فعالیت‌ها", level: 1 })).toBeVisible();
  await expect(page.getByText("بهترین مدرک ثبت‌شده")).toBeVisible();

  await page.getByRole("link", { name: "گفت‌وگو" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/fa/c/${storedId}\\?profile=default$`, "u"),
  );
  await expect(app.messages("user")).toHaveCount(1);
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete", {
    timeout: 10_000,
  });
  await expect(app.messages("assistant").last()).toContainText("پاسخ آهسته");
});

test("renders deterministic Automations and Knowledge details", async ({ app, page }) => {
  await app.open("en");
  await app.ensureSession();

  await page.getByRole("link", { name: "Automations" }).click();
  await expect(page).toHaveURL(/\/en\/automations$/u);
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await expect(page.getByText("Workspace daily brief")).toBeVisible();
  await expect(page.getByText("workspace-daily")).toBeVisible();

  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByText("Deterministic scheduler run completed.")).toBeVisible();
  await expect(page.getByText("2026-07-15.md")).toBeVisible();
  await page.getByRole("button", { name: "View output" }).click();
  await expect(page.getByText("Deterministic test output for the Hermes Workspace.")).toBeVisible();

  await page.getByRole("link", { name: "Knowledge" }).click();
  await expect(page).toHaveURL(/\/en\/knowledge$/u);
  await expect(page.getByRole("heading", { name: "Knowledge", level: 1 })).toBeVisible();
  await expect(page.getByText("Workspace conventions")).toBeVisible();
  await expect(page.getByText("Safe automation review")).toBeVisible();
  await expect(page.getByText("Remember workspace ownership")).toBeVisible();

  const skillReview = page.getByRole("listitem").filter({ hasText: "skill-test" });
  await expect(skillReview.getByRole("button", { name: "Approve" })).toBeDisabled();
  await skillReview.getByRole("button", { name: "Load skill diff" }).click();
  await expect(skillReview).toContainText("without exposing managed paths");
  await expect(skillReview.getByRole("button", { name: "Approve" })).toBeEnabled();
});

test("previews and attaches a deterministic workspace file", async ({ app, page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "The workspace drawer is a mobile interaction");
  await app.open("en");
  await app.ensureSession();

  await page.getByRole("button", { name: "Open workspace" }).click();
  const rail = page.getByTestId("workspace-files-rail");
  await expect(rail).toBeVisible();
  await expect(rail.getByText("README.md")).toBeVisible();
  await rail.getByText("README.md").click();
  await expect(page.getByTestId("workspace-preview")).toContainText("Hermes Workspace");

  await rail.getByRole("button", { name: "Attach to conversation" }).click();
  await expect(page.getByTestId("attachment-item")).toContainText("README.md");
  await rail.getByRole("button", { name: "Close files" }).click();

  await app.sendScenario("attachment");
  await expect(app.messages("user").last()).toContainText("@file:README.md");
  await expect(app.messages("assistant").last()).toContainText("1 پیوست دریافت شد");
});

test("fails closed when a stored conversation URL omits or duplicates profile", async ({ app, page }) => {
  await app.open("en");
  await app.ensureSession();
  const storedId = new URL(page.url()).pathname.split("/").at(-1);
  expect(storedId).toBeTruthy();

  await page.goto(`/en/c/${storedId}`);
  await expect(app.shell).toBeVisible();
  await expect(app.shell.getByRole("alert")).toContainText("exactly one valid owning profile");
  await expect(app.composer).toBeDisabled();
  await expect(app.messages()).toHaveCount(0);

  await page.goto(`/en/c/${storedId}?profile=default&profile=research`);
  await expect(app.shell).toBeVisible();
  await expect(app.shell.getByRole("alert")).toContainText("exactly one valid owning profile");
  await expect(app.composer).toBeDisabled();
  await expect(app.messages()).toHaveCount(0);
});

test("keeps long LTR project and session labels inside the RTL conversation rail", async ({app, page}) => {
  const longProject =
    "hermes-workspace-project-with-a-long-unbroken-technical-name-that-must-stay-contained";
  const longSession =
    "session-recovery-and-automation-validation-with-a-long-unbroken-technical-name";
  const longPreview =
    "preview-with-an-even-longer-unbroken-technical-value-that-forces-grid-intrinsic-sizing-unless-every-track-can-shrink";

  await app.open("fa");
  await app.ensureSession();
  await app.openSessionRail();

  const projectTitle = page.getByTestId("project-session-project-title");
  const sessionTitle = page.getByTestId("project-session-title").first();
  await expect(projectTitle).toBeVisible();
  await expect(sessionTitle).toBeVisible();

  // Keep the shared fake-gateway copy stable for visual snapshots while still
  // exercising browser geometry with pathological mixed-direction text.
  await projectTitle.evaluate((element, value) => { element.textContent = value; }, longProject);
  await sessionTitle.evaluate((element, value) => { element.textContent = value; }, longSession);
  await sessionTitle.evaluate((element, value) => {
    const track = element.parentElement;
    if (!track) throw new Error("Missing session label track");
    const preview = document.createElement("bdi");
    preview.className = "line-clamp-1 block w-full overflow-hidden text-xs text-muted-foreground";
    preview.dataset.testid = "project-session-preview";
    preview.dir = "auto";
    preview.textContent = value;
    track.append(preview);
  }, longPreview);
  const sessionPreview = page.getByTestId("project-session-preview").first();
  await expect(sessionPreview).toBeVisible();

  const geometry = await page.locator(".session-rail").evaluate((rail) => {
    const bounds = rail.getBoundingClientRect();
    const measure = (selector: string) => {
      const element = rail.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing rail label: ${selector}`);
      const rect = element.getBoundingClientRect();
      const text = element.firstChild;
      if (!(text instanceof Text)) throw new Error(`Missing label text: ${selector}`);
      const first = document.createRange();
      first.setStart(text, 0);
      first.setEnd(text, Math.min(1, text.length));
      return {
        firstCharacterLeft: first.getBoundingClientRect().left,
        left: rect.left,
        right: rect.right,
      };
    };
    return {
      project: measure('[data-testid="project-session-project-title"]'),
      preview: measure('[data-testid="project-session-preview"]'),
      railLeft: bounds.left,
      railRight: bounds.right,
      session: measure('[data-testid="project-session-title"]'),
    };
  });

  for (const label of [geometry.project, geometry.session, geometry.preview]) {
    expect(label.left).toBeGreaterThanOrEqual(geometry.railLeft);
    expect(label.right).toBeLessThanOrEqual(geometry.railRight);
    expect(label.firstCharacterLeft).toBeGreaterThanOrEqual(geometry.railLeft);
    expect(label.firstCharacterLeft).toBeLessThanOrEqual(geometry.railRight);
  }
  await app.expectNoPageOverflow();
});
