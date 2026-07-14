import { defineConfig, devices } from "@playwright/test";

const e2ePort = Number(process.env.HERMES_E2E_PORT ?? 3000);
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: e2eBaseUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], browserName: "chromium", channel: "chrome" },
    },
    {
      name: "mobile",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        channel: "chrome",
        viewport: { width: 360, height: 800 },
      },
    },
  ],
  webServer: {
    command: `HERMES_TEST_MODE=1 PORT=${e2ePort} pnpm dev`,
    url: `${e2eBaseUrl}/fa`,
    // Fail closed: never attach deterministic tests to a possibly managed,
    // live Hermes UI already occupying the application port.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
