import { afterEach, describe, expect, it, vi } from "vitest";

import { synthesizeSpeech, transcribeAudioBlob } from "./voice";

afterEach(() => vi.restoreAllMocks());

describe("Hermes voice requests", () => {
  it("sends transcription using the v0.18.2 JSON contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, transcript: "  متن آزمایشی  " }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      transcribeAudioBlob(new Blob(["voice"], { type: "audio/webm" }), fetchImpl),
    ).resolves.toBe("متن آزمایشی");

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      data_url: expect.stringMatching(/^data:audio\/webm;base64,/u),
      mime_type: "audio/webm",
    });
  });

  it("accepts only an audio data URL from speech synthesis", async () => {
    const validFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data_url: "data:audio/wav;base64,UklGRg==" }), { status: 200 }),
    );
    await expect(synthesizeSpeech("سلام", validFetch)).resolves.toBe(
      "data:audio/wav;base64,UklGRg==",
    );
    expect(JSON.parse(String((validFetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      text: "سلام",
    });

    const invalidFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data_url: "data:text/html;base64,PHNjcmlwdD4=" }), { status: 200 }),
    );
    await expect(synthesizeSpeech("سلام", invalidFetch)).rejects.toThrow("invalid audio");
  });

  it("surfaces a backend voice failure without exposing a fake playback", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: "Voice provider is not configured" }), { status: 400 }),
    );
    await expect(synthesizeSpeech("سلام", fetchImpl)).rejects.toThrow(
      "Voice provider is not configured",
    );
  });
});
