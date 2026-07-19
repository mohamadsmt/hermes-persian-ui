import {expect, test} from "../fixtures/hermes-app";

test("keeps a long LTR learning label inside its RTL timeline row", async ({app, page}) => {
  const longTitle =
    "iran-gold-fx-market-analysis-with-a-long-unbroken-technical-name-that-must-stay-contained";

  await page.route("**/api/hermes/learning/timeline?profile=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        profile: "default",
        items: [
          {
            id: "skill-long-ltr-title",
            kind: "skill",
            label: longTitle,
            timestamp: "2026-07-15T08:30:00.000Z",
          },
        ],
      },
      status: 200,
    });
  });

  await app.open("fa");
  await app.openWorkspaceNavigation();
  await page.getByRole("link", {name: "دانش"}).click();

  const row = page.getByTestId("knowledge-timeline-row");
  const title = page.getByTestId("knowledge-timeline-title");
  await expect(title).toContainText(longTitle);

  const geometry = await row.evaluate((element) => {
    const rowRect = element.getBoundingClientRect();
    const title = element.querySelector<HTMLElement>(
      '[data-testid="knowledge-timeline-title"]',
    );
    if (!title) throw new Error("Timeline title is missing");

    const titleRect = title.getBoundingClientRect();
    const firstTextNode = title.querySelector("bdi")?.firstChild ?? title.firstChild;
    if (!(firstTextNode instanceof Text)) {
      throw new Error("Timeline title does not contain a text node");
    }
    const firstCharacter = document.createRange();
    firstCharacter.setStart(firstTextNode, 0);
    firstCharacter.setEnd(firstTextNode, Math.min(1, firstTextNode.length));
    const firstCharacterRect = firstCharacter.getBoundingClientRect();

    return {
      firstCharacterLeft: firstCharacterRect.left,
      rowLeft: rowRect.left,
      rowRight: rowRect.right,
      titleLeft: titleRect.left,
      titleRight: titleRect.right,
    };
  });

  expect(geometry.titleLeft).toBeGreaterThanOrEqual(geometry.rowLeft);
  expect(geometry.titleRight).toBeLessThanOrEqual(geometry.rowRight);
  expect(geometry.firstCharacterLeft).toBeGreaterThanOrEqual(geometry.rowLeft);
  await app.expectNoPageOverflow();
});
