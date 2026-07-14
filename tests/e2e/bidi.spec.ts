import { BIDI_FIXTURES, BIDI_MARKDOWN } from "../fixtures/bidi";
import { expect, test } from "../fixtures/hermes-app";

test("renders every Markdown block independently and technical content LTR", async ({
  app,
  context,
  page,
}) => {
  await app.open();
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await app.sendScenario("bidi");

  const response = app.messages("assistant").last();
  await expect(response).toHaveAttribute("data-status", "complete");
  const blocks = response.getByTestId("bidi-block");
  await expect.poll(() => blocks.count()).toBeGreaterThanOrEqual(BIDI_FIXTURES.length);

  for (const block of await blocks.all()) {
    await expect(block).toHaveAttribute("dir", "auto");
    expect(await block.evaluate((element) => getComputedStyle(element).textAlign)).toBe("start");
    expect(await block.evaluate((element) => getComputedStyle(element).unicodeBidi)).toBe(
      "plaintext",
    );
  }

  const code = response.getByTestId("code-block");
  await expect(code).toBeVisible();
  expect(await code.evaluate((element) => getComputedStyle(element).direction)).toBe("ltr");
  expect(await code.evaluate((element) => getComputedStyle(element).textAlign)).toBe("left");
  await expect(response.locator("bdi").first()).toBeVisible();

  await code.getByTestId("copy-code").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(
    'const endpoint = "/v1/responses";\nconsole.log(endpoint);',
  );

  await response.getByTestId("copy-message").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(BIDI_MARKDOWN);
});

test("mixed-content punctuation and identifiers remain in logical order", async ({ app }) => {
  await app.open();
  await app.sendScenario("bidi");
  const response = app.messages("assistant").last();

  for (const token of [
    "/v1/responses",
    "src/components/Chat.tsx",
    "README.md",
    "claude-sonnet-4.6",
    "$1,250",
    "20%",
    "TypeError:",
  ]) {
    await expect(response).toContainText(token);
  }

  await app.expectNoPageOverflow();
});
