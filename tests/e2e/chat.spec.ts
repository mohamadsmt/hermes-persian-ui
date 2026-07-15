import { expect, test } from "../fixtures/hermes-app";

test("streams tool progress separately and completes the assistant response", async ({
  app,
  page,
}) => {
  await app.open();
  await app.sendScenario("tool");

  const tool = page.getByTestId("tool-card").last();
  await expect(tool).toBeVisible();
  await expect(tool).toHaveAttribute("data-status", "complete");
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
});

test("preserves the ordered reasoning/tool timeline and contains long tool output", async ({
  app,
  page,
}) => {
  await app.open();
  await app.sendScenario("timelineOverflow");

  const assistant = app.messages("assistant");
  await expect(assistant).toHaveCount(1);
  await expect(assistant.last()).toHaveAttribute("data-status", "complete");
  await expect(assistant.last()).toContainText("پاسخ نهایی timeline");
  await expect(app.transcript).not.toContainText("INTERNAL_THINKING_MUST_NOT_RENDER");

  const reasoning = page.getByTestId("reasoning");
  const tools = page.getByTestId("tool-card");
  await expect(reasoning).toHaveCount(2);
  await expect(tools).toHaveCount(2);
  await expect(reasoning.first()).toContainText("بررسی نهایی اول");
  await expect(reasoning.first()).not.toContainText("بررسی ناقص اول");
  await expect(tools.nth(0)).toHaveAttribute("data-status", "failed");
  await expect(tools.nth(1)).toHaveAttribute("data-status", "complete");
  await expect.poll(() => tools.locator(".tool-card__header").evaluateAll((nodes) =>
    nodes.every((node) => node.getAttribute("aria-expanded") === "false"),
  )).toBe(true);
  await expect.poll(() => reasoning.evaluateAll((nodes) =>
    nodes.every((node) => !(node as HTMLDetailsElement).open),
  )).toBe(true);

  const orderedParts = await page.locator(
    '[data-testid="reasoning"], [data-testid="tool-card"], [data-testid="message"][data-role="assistant"]',
  ).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  expect(orderedParts).toEqual(["reasoning", "tool-card", "reasoning", "tool-card", "message"]);

  await app.transcript.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => app.transcript.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeGreaterThan(96);
  await expect.poll(() => page.locator(".transcript-virtual-item").evaluateAll((nodes) => {
    const boxes = nodes
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          index: Number((node as HTMLElement).dataset.index),
          top: box.top,
          bottom: box.bottom,
        };
      })
      .sort((left, right) => left.index - right.index);
    return boxes.every((box, index) => {
      const previous = boxes[index - 1];
      if (!previous || box.index !== previous.index + 1) return true;
      const gap = box.top - previous.bottom;
      return gap >= -1 && gap <= 4;
    });
  })).toBe(true);

  const failedTool = tools.nth(0);
  await failedTool.locator(".tool-card__header").click();
  await expect(failedTool.locator(".tool-card__header")).toHaveAttribute("aria-expanded", "true");
  await expect(failedTool).toContainText("agent not found");
  await expect.poll(() => app.transcript.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeGreaterThan(96);

  const containment = await failedTool.evaluate((node) => {
    const viewport = node.closest('[data-testid="transcript"]') as HTMLElement | null;
    const blocks = node.querySelectorAll<HTMLElement>(".technical-block");
    const block = blocks.item(blocks.length - 1);
    if (!viewport || !block) return null;
    const viewportBox = viewport.getBoundingClientRect();
    const cardBox = node.getBoundingClientRect();
    const blockBox = block.getBoundingClientRect();
    const inside = (box: DOMRect) =>
      box.left >= viewportBox.left - 1 && box.right <= viewportBox.right + 1;
    return {
      cardInside: inside(cardBox),
      blockInside: inside(blockBox),
      noHorizontalBlockOverflow: block.scrollWidth <= block.clientWidth + 2,
      verticallyScrollable: block.scrollHeight > block.clientHeight,
    };
  });
  expect(containment).toEqual({
    cardInside: true,
    blockInside: true,
    noHorizontalBlockOverflow: true,
    verticallyScrollable: true,
  });
  await app.expectNoPageOverflow();

  await page.reload();
  await expect(app.connectionStatus).toHaveText(/^(?:متصل|Connected)$/iu, { timeout: 15_000 });
  await expect(page.getByTestId("tool-card")).toHaveCount(2);
  await expect(page.getByTestId("tool-card").nth(0)).toHaveAttribute("data-status", "failed");
  await expect(page.getByTestId("tool-card").nth(1)).toHaveAttribute("data-status", "complete");
  await expect(page.getByTestId("reasoning")).toHaveCount(2);
  await expect(app.messages("assistant")).toHaveCount(1);
  await expect.poll(() => page.getByTestId("tool-card").locator(".tool-card__header").evaluateAll(
    (nodes) => nodes.every((node) => node.getAttribute("aria-expanded") === "false"),
  )).toBe(true);

  await app.transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => app.transcript.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight,
  )).toBeLessThan(96);
  const finalTool = page.getByTestId("tool-card").last();
  await finalTool.locator(".tool-card__header").click();
  await expect(finalTool.locator(".tool-card__header")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => page.locator(".transcript-virtual-item").evaluateAll((nodes) => {
    const boxes = nodes
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          index: Number((node as HTMLElement).dataset.index),
          top: box.top,
          bottom: box.bottom,
        };
      })
      .sort((left, right) => left.index - right.index);
    return boxes.every((box, index) => {
      const previous = boxes[index - 1];
      if (!previous || box.index !== previous.index + 1) return true;
      const gap = box.top - previous.bottom;
      return gap >= -1 && gap <= 4;
    });
  })).toBe(true);
  await expect.poll(async () => {
    const latestBox = await app.messages("assistant").last().boundingBox();
    const composerBox = await page.locator(".composer-wrap").boundingBox();
    return latestBox && composerBox ? latestBox.y + latestBox.height <= composerBox.y + 1 : false;
  }, { timeout: 15_000 }).toBe(true);
});

test("keeps the latest item above a multiline composer and caps a long queue", async ({
  app,
  page,
}) => {
  await app.open();
  await app.sendScenario("timelineOverflow");
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");

  await app.composer.fill(Array.from({ length: 10 }, (_, index) => `خط ${index + 1}`).join("\n"));
  await expect.poll(() => page.locator(".chat-main").evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).getPropertyValue("--composer-block-size")),
  )).toBeGreaterThan(180);
  await expect.poll(async () => {
    const latestBox = await app.messages("assistant").last().boundingBox();
    const composerBox = await page.locator(".composer-wrap").boundingBox();
    return latestBox && composerBox ? latestBox.y + latestBox.height <= composerBox.y + 1 : false;
  }).toBe(true);

  await app.composer.fill("");
  await app.transcript.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByTestId("jump-latest")).toBeVisible();
  const historyScrollTop = await app.transcript.evaluate((element) => element.scrollTop);
  await app.composer.fill(Array.from({ length: 10 }, (_, index) => `مطالعه ${index + 1}`).join("\n"));
  await expect.poll(() => page.locator(".chat-main").evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).getPropertyValue("--composer-block-size")),
  )).toBeGreaterThan(180);
  await expect.poll(() => app.transcript.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(
    historyScrollTop + 2,
  );
  await app.composer.fill("");
  await page.getByTestId("jump-latest").click();

  await app.sendScenario("toolRunningArtifact");
  await expect(page.getByTestId("stop-run")).toBeVisible();
  try {
    for (let index = 0; index < 8; index += 1) {
      await app.composer.fill(`پیام صف ${index + 1}`);
      await page.getByTestId("send-message").click();
      await expect(app.composer).toHaveValue("");
    }
    const queue = page.locator(".composer-queue");
    await expect(queue.locator(".queued-prompt")).toHaveCount(8);
    await expect.poll(() => queue.evaluate((element) => ({
      capped: element.clientHeight <= window.innerHeight * 0.32 + 2,
      scrollable: element.scrollHeight > element.clientHeight,
    }))).toEqual({ capped: true, scrollable: true });
  } finally {
    const stop = page.getByTestId("stop-run");
    if (await stop.isVisible()) await stop.click();
  }
});

test("interrupts a slow run without disconnecting the session", async ({ app, page }) => {
  await app.open();
  await app.sendScenario("slow");

  const stop = page.getByTestId("stop-run");
  await expect(stop).toBeVisible();
  await stop.click();
  await expect(stop).toBeHidden();
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "interrupted");
  await expect(app.connectionStatus).toBeVisible();
});

test("approval defaults to the safe response and cannot submit twice", async ({ app, page }) => {
  await app.open();
  await app.sendScenario("approval");

  const dialog = page.getByTestId("approval-dialog");
  await expect(dialog).toBeVisible();
  const deny = page.getByTestId("approval-deny");
  await expect(deny).toBeFocused();
  await deny.click();
  await expect(dialog).toBeHidden();
  await expect(deny).toBeHidden();
});

test("Enter sends, Shift+Enter keeps a logical newline, and whitespace is rejected", async ({
  app,
  page,
}) => {
  await app.open();
  await app.ensureSession();

  await app.composer.fill("خط اول");
  await page.keyboard.press("Shift+Enter");
  await app.composer.pressSequentially("line two");
  await expect(app.composer).toHaveValue("خط اول\nline two");
  await page.keyboard.press("Enter");
  await expect(app.messages("user").last()).toContainText("خط اول");

  await app.composer.fill("   ");
  await expect(page.getByTestId("send-message")).toBeDisabled();
});

test("attaches a file through the real transport boundary", async ({ app, page }) => {
  await app.open();
  await app.ensureSession();

  await page.getByTestId("attachment-input").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("deterministic attachment\n", "utf8"),
  });
  await expect(page.getByTestId("attachment-item")).toContainText("sample.txt");
  await app.sendScenario("attachment");
  await expect(app.messages("user").last()).toContainText("@file:sample.txt");
  await expect(page.getByTestId("attachment-item")).toHaveCount(0);
  await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
});
