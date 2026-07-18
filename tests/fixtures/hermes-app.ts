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

  currentSessionId(): string | undefined {
    const pathname = new URL(this.page.url()).pathname;
    const match = pathname.match(/\/(?:fa|en)\/c\/([^/?#]+)/u);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  }

  sessionItem(storedId: string): Locator {
    return this.page.locator(
      `[data-testid="session-item"][data-session-id="${storedId}"]`,
    );
  }

  sessionStatus(storedId: string): Locator {
    return this.sessionItem(storedId).getByTestId("session-status-indicator");
  }

  async gatewayRpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.page.evaluate(
      ({ rpcMethod, rpcParams }) => new Promise<T>((resolve, reject) => {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(
          `${protocol}//${window.location.host}/api/hermes/ws`,
        );
        const requestId = `e2e-control-${Date.now()}-${Math.random()}`;
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error(`Timed out waiting for test gateway RPC: ${rpcMethod}`));
        }, 10_000);
        const finish = () => {
          window.clearTimeout(timeout);
          if (socket.readyState === WebSocket.OPEN) socket.close();
        };

        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method: rpcMethod,
            params: rpcParams,
          }));
        });
        socket.addEventListener("message", (event) => {
          let frame: {
            id?: string;
            result?: T;
            error?: { message?: string };
          };
          try {
            frame = JSON.parse(String(event.data)) as typeof frame;
          } catch {
            return;
          }
          if (frame.id !== requestId) return;
          finish();
          if (frame.error) reject(new Error(frame.error.message || `Gateway RPC failed: ${rpcMethod}`));
          else resolve(frame.result as T);
        });
        socket.addEventListener("error", () => {
          finish();
          reject(new Error(`Could not open test gateway control socket: ${rpcMethod}`));
        });
      }),
      { rpcMethod: method, rpcParams: params },
    );
  }

  async activeRuntimeId(storedId: string): Promise<string> {
    const result = await this.gatewayRpc<{
      sessions: Array<{ id: string; session_key: string }>;
    }>("session.active_list");
    const runtimeId = result.sessions.find(
      (session) => session.session_key === storedId,
    )?.id;
    if (!runtimeId) throw new Error(`No active runtime found for ${storedId}`);
    return runtimeId;
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

    // Opening the rail is idempotent in the product. A failed transactional
    // action intentionally leaves it open, so do not click through its overlay.
    if (await mobileTrigger.isVisible()) {
      const rail = this.page.locator(".session-rail");
      if (!(await rail.getAttribute("class"))?.includes("session-rail--mobile-open")) {
        await mobileTrigger.click();
      }
      await expect(rail).toHaveClass(
        /session-rail--mobile-open/u,
      );
      await expect(newSession).toBeInViewport();
      await this.openManagedConversations();
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
    await this.openManagedConversations();
  }

  private async openManagedConversations(): Promise<void> {
    await expect(this.page.locator(".session-rail .session-skeleton")).toHaveCount(0, {
      timeout: 15_000,
    });
    const management = this.page.getByTestId("project-session-management");
    if (await management.count() === 0) return;
    if (await management.getAttribute("open") === null) {
      await management.locator("summary").click();
    }
    await expect(management).toHaveAttribute("open", "");
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

  async selectSession(storedId: string): Promise<void> {
    await this.openSessionRail();
    const item = this.sessionItem(storedId);
    await expect(item).toBeVisible();
    await item.locator(".session-row__main").click();
    await expect(this.page).toHaveURL(
      new RegExp(`/(?:fa|en)/c/${storedId}\\?profile=[^&#]+$`, "u"),
    );
    await expect(this.composer).toBeVisible();
    await expect(this.composer).toBeEnabled();
  }

  async ensureSession(): Promise<void> {
    if (!/\/(?:fa|en)\/c\//u.test(new URL(this.page.url()).pathname)) {
      await this.createSession();
    }
    await expect(this.composer).toBeVisible();
    await expect(this.composer).toBeEnabled();
    // Next streams metadata independently from the client-routed shell. Treat
    // the session transition as settled only once its explicit segment title
    // has arrived, otherwise accessibility scans can race the head update.
    await expect(this.page).toHaveTitle(/\S/u, { timeout: 15_000 });
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
