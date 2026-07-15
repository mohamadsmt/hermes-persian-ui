import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

export const TEST_SCENARIOS = {
  approval: "__TEST__:approval",
  attachment: "__TEST__:attachment",
  bidi: "__TEST__:bidi",
  slow: "__TEST__:slow",
  tool: "__TEST__:tool",
  toolRunningArtifact: "__TEST__:tool-running-artifact",
  timelineOverflow: "__TEST__:timeline-overflow",
} as const;

export class HermesApp {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  get shell(): Locator {
    return this.page.getByTestId("app-shell");
  }

  get composer(): Locator {
    return this.page.getByTestId("composer").locator("textarea");
  }

  get transcript(): Locator {
    return this.page.getByTestId("transcript");
  }

  get connectionStatus(): Locator {
    return this.page.getByTestId("connection-status");
  }

  messages(role?: "assistant" | "system" | "tool" | "user"): Locator {
    const selector = role
      ? `[data-testid="message"][data-role="${role}"]`
      : '[data-testid="message"]';
    return this.page.locator(selector);
  }

  async open(locale: "en" | "fa" = "fa"): Promise<void> {
    await this.page.goto(`/${locale}`);
    await expect(this.page).toHaveTitle(/\S/u, { timeout: 15_000 });
    await expect(this.shell).toBeVisible();
    await expect(this.connectionStatus).toBeVisible();
    await expect(this.connectionStatus).toHaveText(/^(?:متصل|Connected)$/iu, {
      timeout: 15_000,
    });
  }

  async openSessionRail(): Promise<void> {
    const newSession = this.page.getByTestId("new-session");
    const mobileTrigger = this.page.getByRole("button", {
      name: /بازکردن فهرست گفت‌وگوها|open conversations/iu,
    });

    // Opening the rail is idempotent in the product. On narrow viewports we
    // always drive that explicit state transition so a route-change closing
    // animation cannot race a stale bounding-box probe.
    if (await mobileTrigger.isVisible()) {
      await mobileTrigger.click();
      await expect(this.page.locator(".session-rail")).toHaveClass(
        /session-rail--mobile-open/u,
      );
      await expect(newSession).toBeInViewport();
      return;
    }

    const isInViewport = await newSession.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    });

    if (!isInViewport) {
      throw new Error("Session rail is outside the desktop viewport");
    }
  }

  async createSession(): Promise<void> {
    await this.openSessionRail();
    const previousUrl = this.page.url();
    await this.page.getByTestId("new-session").click();
    const dialogSubmit = this.page.getByTestId("create-session");
    if (await dialogSubmit.isVisible()) await dialogSubmit.click();
    await expect.poll(() => this.page.url()).not.toBe(previousUrl);
    await expect(this.page).toHaveURL(/\/(?:fa|en)\/c\/[^/?#]+\?profile=[^&#]+$/u);
  }

  async ensureSession(): Promise<void> {
    if (!/\/(?:fa|en)\/c\//u.test(new URL(this.page.url()).pathname)) {
      await this.createSession();
    }
    await expect(this.composer).toBeVisible();
    await expect(this.composer).toBeEnabled();
  }

  async send(source: string): Promise<void> {
    await this.ensureSession();
    const previousUserMessageCount = await this.messages("user").count();
    await this.composer.fill(source);
    await this.page.getByTestId("send-message").click();
    await expect(this.messages("user")).toHaveCount(previousUserMessageCount + 1);
    // Message bodies render Markdown. Test-only `__TEST__:*` sentinels therefore
    // display without their emphasis delimiters; raw-source equality is covered
    // separately through the message copy action.
    await expect(this.messages("user").last()).toContainText(source.replaceAll("__", ""));
  }

  async sendScenario(scenario: keyof typeof TEST_SCENARIOS): Promise<void> {
    await this.send(TEST_SCENARIOS[scenario]);
  }

  async expectNoPageOverflow(): Promise<void> {
    await expect
      .poll(() =>
        this.page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
}

export const test = base.extend<{ app: HermesApp }>({
  app: async ({ baseURL, context, page }, provide) => {
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await context.addCookies([
      {
        name: "hermes-e2e-client",
        value: randomUUID(),
        url: baseURL,
      },
    ]);
    await provide(new HermesApp(page));
  },
});

export { expect } from "@playwright/test";
