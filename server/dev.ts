import { startHermesUiServer } from "./app-server.js"
import { FakeHermesGatewayAdapter } from "./fake-gateway.js"

const testMode = process.env.HERMES_TEST_MODE === "1"

await startHermesUiServer({
  dev: true,
  allowTestMode: testMode,
  ...(testMode ? { testGateway: new FakeHermesGatewayAdapter() } : {}),
})
