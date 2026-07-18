import type { Page, WebSocket as PlaywrightWebSocket } from "@playwright/test";

import { expect, test } from "../fixtures/hermes-app";

type RpcRequestFrame = {
  method?: string;
  params?: Record<string, unknown>;
};

function traceRpcRequests(page: Page): RpcRequestFrame[] {
  const requests: RpcRequestFrame[] = [];
  const observe = (socket: PlaywrightWebSocket) => {
    socket.on("framesent", ({ payload }) => {
      try {
        const parsed = JSON.parse(
          typeof payload === "string" ? payload : payload.toString("utf8"),
        ) as RpcRequestFrame;
        if (parsed.method) requests.push(parsed);
      } catch {
        // Non-JSON frames are irrelevant to the JSON-RPC transport assertion.
      }
    });
  };
  page.on("websocket", observe);
  return requests;
}

test.describe("concurrent live conversations", () => {
  test("preserves the selected URL and transcript when create or activate fails", async ({
    app,
    page,
  }) => {
    const requests = traceRpcRequests(page);
    await app.open();
    await app.ensureSession();
    await app.send("متن پایدار مکالمهٔ A");
    await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
    const firstStoredId = app.currentSessionId();
    const firstUrl = page.url();
    expect(firstStoredId).toBeTruthy();

    await app.gatewayRpc("test.fail_next", { operation: "create" });
    await app.openSessionRail();
    await page.getByTestId("new-session").click();
    await page.getByTestId("create-session").click();
    await expect(page.getByTestId("new-session-dialog")).toBeHidden();
    await expect(page).toHaveURL(firstUrl);
    await expect(page.getByText("maximum concurrent sessions reached", { exact: false })).toBeVisible();
    await expect(app.messages("user")).toHaveCount(1);
    await expect(app.messages("user").last()).toContainText("متن پایدار مکالمهٔ A");
    await expect(app.messages("assistant")).toHaveCount(1);

    await app.createSession();
    const secondStoredId = app.currentSessionId();
    expect(secondStoredId).toBeTruthy();
    expect(secondStoredId).not.toBe(firstStoredId);
    await app.send("متن مخصوص مکالمهٔ B");
    await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
    const secondRuntimeId = await app.activeRuntimeId(secondStoredId!);

    await app.selectSession(firstStoredId!);
    await expect(app.messages("user").last()).toContainText("متن پایدار مکالمهٔ A");
    const beforeFailedActivation = requests.length;
    await app.gatewayRpc("test.fail_next", {
      operation: "activate",
      session_id: secondRuntimeId,
    });
    await app.openSessionRail();
    await app.sessionItem(secondStoredId!).locator(".session-row__main").click();

    await expect.poll(() => requests.slice(beforeFailedActivation).some((request) => (
      request.method === "session.activate"
      && request.params?.session_id === secondRuntimeId
    ))).toBe(true);
    await expect(page.getByText("runtime activation failed", { exact: false })).toBeVisible();
    await expect(page).toHaveURL(firstUrl);
    await expect(app.messages("user")).toHaveCount(1);
    await expect(app.messages("user").last()).toContainText("متن پایدار مکالمهٔ A");
    await expect(app.transcript).not.toContainText("متن مخصوص مکالمهٔ B");
  });

  test("runs B independently while A keeps streaming and restores A mid-stream", async ({
    app,
    page,
  }) => {
    await app.open();
    await app.ensureSession();
    const firstStoredId = app.currentSessionId();
    expect(firstStoredId).toBeTruthy();

    await app.send("مکالمهٔ A __TEST__:slow");
    await expect(page.getByTestId("stop-run")).toBeVisible();

    await app.createSession();
    const secondStoredId = app.currentSessionId();
    expect(secondStoredId).toBeTruthy();
    expect(secondStoredId).not.toBe(firstStoredId);

    await app.send("پاسخ مستقل برای مکالمهٔ B");
    await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
    await expect(app.messages("assistant").last()).toContainText("Hermes");

    await app.selectSession(firstStoredId!);

    await expect(app.messages("user").last()).toContainText("مکالمهٔ A TEST:slow");
    await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "streaming");
    await expect(app.messages("assistant").last()).not.toHaveText("");
    await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete", {
      timeout: 8_000,
    });
    await expect(app.messages("assistant").last()).toContainText(
      "این یک پاسخ آهسته و قابل توقف است",
    );

    await app.selectSession(secondStoredId!);
    await expect(app.messages("user").last()).toContainText("پاسخ مستقل برای مکالمهٔ B");
    await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
  });

  test("stops only A while B finishes in the background and becomes unread", async ({
    app,
    page,
  }) => {
    await app.open();
    await app.ensureSession();
    const firstStoredId = app.currentSessionId();
    expect(firstStoredId).toBeTruthy();
    await app.send("مکالمهٔ A __TEST__:slow");

    await app.createSession();
    const secondStoredId = app.currentSessionId();
    expect(secondStoredId).toBeTruthy();
    await app.send("مکالمهٔ B __TEST__:slow");
    await expect(page.getByTestId("stop-run")).toBeVisible();

    await app.selectSession(firstStoredId!);
    const stop = page.getByTestId("stop-run");
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(stop).toBeHidden();
    await expect(app.messages("assistant").last()).toHaveAttribute(
      "data-status",
      "interrupted",
    );

    await app.openSessionRail();
    await expect(app.sessionStatus(secondStoredId!)).toHaveAttribute(
      "data-session-status",
      "working",
    );
    await expect(app.sessionStatus(secondStoredId!)).toHaveAttribute(
      "data-session-status",
      "unread",
      { timeout: 8_000 },
    );

    await app.selectSession(secondStoredId!);
    await expect(app.messages("user").last()).toContainText("مکالمهٔ B TEST:slow");
    await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete");
    await expect(app.messages("assistant").last()).toContainText(
      "این یک پاسخ آهسته و قابل توقف است",
    );
    await app.openSessionRail();
    await expect(app.sessionStatus(secondStoredId!)).toHaveAttribute(
      "data-session-status",
      "idle",
    );
  });

  test("surfaces a background approval and accepts the response after returning", async ({
    app,
  }) => {
    await app.open();
    await app.ensureSession();
    const approvalStoredId = app.currentSessionId();
    expect(approvalStoredId).toBeTruthy();
    await app.sendScenario("approval");
    await expect(app.page.getByTestId("approval-dialog")).toBeVisible();

    await app.createSession();
    const siblingStoredId = app.currentSessionId();
    expect(siblingStoredId).not.toBe(approvalStoredId);
    await expect(app.page.getByTestId("approval-dialog")).toHaveCount(0);

    await app.openSessionRail();
    await expect(app.sessionStatus(approvalStoredId!)).toHaveAttribute(
      "data-session-status",
      "needs-input",
    );

    await app.selectSession(approvalStoredId!);
    const dialog = app.page.getByTestId("approval-dialog");
    await expect(dialog).toBeVisible();
    await app.page.getByTestId("approval-approve").click();
    await expect(dialog).toBeHidden();
    await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete", {
      timeout: 8_000,
    });
    await expect(app.messages("assistant").last()).toContainText("تأیید شد");
  });

  test("switches between empty live conversations through session.activate", async ({
    app,
    page,
  }) => {
    const requests = traceRpcRequests(page);
    await app.open();
    await app.ensureSession();
    const firstStoredId = app.currentSessionId();
    expect(firstStoredId).toBeTruthy();

    await app.createSession();
    const secondStoredId = app.currentSessionId();
    expect(secondStoredId).toBeTruthy();
    expect(secondStoredId).not.toBe(firstStoredId);
    await expect(app.messages()).toHaveCount(0);

    const beforeFirstSwitch = requests.length;
    await app.selectSession(firstStoredId!);
    await expect(app.messages()).toHaveCount(0);
    await expect.poll(() => requests.slice(beforeFirstSwitch).some(
      (request) => request.method === "session.activate",
    )).toBe(true);
    expect(requests.slice(beforeFirstSwitch).some(
      (request) => request.method === "session.resume",
    )).toBe(false);

    const beforeSecondSwitch = requests.length;
    await app.selectSession(secondStoredId!);
    await expect(app.messages()).toHaveCount(0);
    await expect.poll(() => requests.slice(beforeSecondSwitch).some(
      (request) => request.method === "session.activate",
    )).toBe(true);
    expect(requests.slice(beforeSecondSwitch).some(
      (request) => request.method === "session.resume",
    )).toBe(false);

    await app.openSessionRail();
    await expect(app.sessionStatus(firstStoredId!)).toHaveAttribute("data-session-status", "idle");
    await expect(app.sessionStatus(secondStoredId!)).toHaveAttribute("data-session-status", "idle");
  });

  test("reconnects during a slow stream without duplicating deltas or resubmitting", async ({
    app,
    page,
  }) => {
    const requests = traceRpcRequests(page);
    await app.open();
    await app.ensureSession();
    const storedId = app.currentSessionId();
    expect(storedId).toBeTruthy();
    const runtimeId = await app.activeRuntimeId(storedId!);
    const source = "مکالمهٔ reconnect __TEST__:slow";

    await app.send(source);
    const assistant = app.messages("assistant").last();
    await expect(assistant).toHaveAttribute("data-status", "streaming");
    await expect(assistant.locator(".message__content")).not.toHaveText("");
    expect(requests.filter((request) => request.method === "prompt.submit")).toHaveLength(1);

    const beforeDisconnect = requests.length;
    await app.gatewayRpc("test.disconnect_all");
    await expect(app.connectionStatus).toHaveText(/^(?:متصل|Connected)$/iu, {
      timeout: 15_000,
    });
    await expect.poll(() => requests.slice(beforeDisconnect).some((request) => (
      request.method === "session.activate"
      && request.params?.session_id === runtimeId
    ))).toBe(true);

    await expect(app.messages("assistant").last()).toHaveAttribute("data-status", "complete", {
      timeout: 8_000,
    });
    await expect(app.messages("user")).toHaveCount(1);
    await expect(app.messages("user").last().locator(".message__content")).toHaveText(
      source.replaceAll("__", ""),
    );
    await expect(app.messages("assistant")).toHaveCount(1);
    await expect(app.messages("assistant").last().locator(".message__content")).toHaveText(
      "این یک پاسخ آهسته و قابل توقف است.",
    );
    expect(requests.filter((request) => request.method === "prompt.submit")).toHaveLength(1);
  });
});
