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
