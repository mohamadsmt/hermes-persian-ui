export type ConnectionPhase =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "incompatible"
  | "error";

export type SessionSummary = {
  storedId: string;
  runtimeId?: string;
  title: string;
  preview?: string;
  cwd?: string;
  gitRepoRoot?: string;
  updatedAt?: string;
  createdAt?: string;
  messageCount?: number;
  profile?: string;
  model?: string;
  status?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  rawSource: string;
  createdAt?: string;
  status?: "streaming" | "complete" | "interrupted" | "error";
  model?: string;
  reasoning?: string;
  /** Zero-based ordinal among authoritative durable user rows. */
  userOrdinal?: number;
};

export type ReasoningBlock = {
  id: string;
  content: string;
  createdAt?: string;
  status?: "streaming" | "complete" | "interrupted" | "error";
};

export type ToolRun = {
  id: string;
  name: string;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  input?: unknown;
  output?: unknown;
  progress?: number;
  progressText?: string;
  inlineDiff?: string;
  durationSeconds?: number;
  artifactIds?: string[];
};

export type PromptKind = "approval" | "clarification" | "sudo" | "secret";

export type InteractivePrompt = {
  id: string;
  requestId: string;
  kind: PromptKind;
  title: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
  expiresAt?: string;
  submitted?: boolean;
};

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type KnownReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type ReasoningEffort =
  | KnownReasoningEffort
  | (string & Record<never, never>);

export type SessionModelSettings = {
  model?: string;
  provider?: string;
  reasoning?: ReasoningEffort;
  fast?: boolean;
  yolo?: boolean;
};

export type ComposerAttachment = {
  id: string;
  name: string;
  kind: "image" | "pdf" | "file";
  size: number;
  mimeType: string;
  previewUrl?: string;
  remoteId?: string;
  refText?: string;
  status: "pending" | "uploading" | "ready" | "failed";
  error?: string;
  file?: File;
};

export type Artifact = {
  id: string;
  title: string;
  kind: "markdown" | "text" | "code" | "diff" | "image" | "html";
  content: string;
  language?: string;
  sourceToolId?: string;
};

export type CommandOption = {
  name: string;
  description?: string;
  usage?: string;
  category?: string;
  categoryLabel?: string;
  source?: "builtin" | "skill" | "quick" | "completion";
};

export type SlashCompletionItem = {
  text: string;
  display?: string;
  meta?: string;
};

export type SlashCompletion = {
  items: SlashCompletionItem[];
  replaceFrom: number;
};

export type TranscriptItem =
  | { kind: "message"; key: string; message: ChatMessage }
  | { kind: "reasoning"; key: string; reasoning: ReasoningBlock }
  | { kind: "tool"; key: string; tool: ToolRun }
  | { kind: "prompt"; key: string; prompt: InteractivePrompt };
