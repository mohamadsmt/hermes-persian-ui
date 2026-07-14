import { describe, expect, it } from "vitest"

import { MAX_HERMES_FRAME_BYTES } from "../server/ws-relay"

describe("Hermes WebSocket relay payload contract", () => {
  it("fits a 50 MiB attachment after base64 and JSON-RPC expansion", () => {
    const rawPdfBytes = 50 * 1024 * 1024
    const base64Bytes = Math.ceil(rawPdfBytes / 3) * 4
    const conservativeJsonRpcOverhead = 1024 * 1024

    expect(MAX_HERMES_FRAME_BYTES).toBe(70 * 1024 * 1024)
    expect(base64Bytes + conservativeJsonRpcOverhead).toBeLessThan(MAX_HERMES_FRAME_BYTES)
  })
})
