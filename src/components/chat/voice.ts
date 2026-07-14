export type SpeechPlayback = {
  finished: Promise<void>;
  stop: () => void;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function responseError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  const detail = record.detail ?? record.error ?? record.message;
  return typeof detail === "string" && detail.trim() ? detail : fallback;
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read audio"));
    reader.readAsDataURL(blob);
  });
}

export async function transcribeAudioBlob(
  blob: Blob,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<string> {
  const dataUrl = await blobToDataUrl(blob);
  const response = await fetchImpl("/api/hermes/audio/transcribe", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      data_url: dataUrl,
      mime_type: blob.type || "audio/webm",
    }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(responseError(payload, "Audio transcription failed"));
  if (!payload || typeof payload !== "object") throw new Error("Audio transcription returned an invalid response");
  const record = payload as Record<string, unknown>;
  const transcript = record.transcript ?? record.text;
  return typeof transcript === "string" ? transcript.trim() : "";
}

export async function synthesizeSpeech(
  text: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<string> {
  const response = await fetchImpl("/api/hermes/audio/speak", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ text }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(responseError(payload, "Speech synthesis failed"));
  if (!payload || typeof payload !== "object") throw new Error("Speech synthesis returned an invalid response");
  const dataUrl = (payload as Record<string, unknown>).data_url;
  if (typeof dataUrl !== "string" || !/^data:audio\/[a-z0-9.+-]+;base64,/iu.test(dataUrl)) {
    throw new Error("Speech synthesis returned invalid audio");
  }
  return dataUrl;
}
