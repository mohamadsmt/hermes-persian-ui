import { z } from "zod"

import { HERMES_DESKTOP_CONTRACT } from "./types"

export const capabilitySetSchema = z.object({
  gateway: z.boolean(),
  sessions: z.boolean(),
  models: z.boolean(),
  attachments: z.boolean(),
  approvals: z.boolean(),
  clarification: z.boolean(),
  sudo: z.boolean(),
  secrets: z.boolean(),
  branch: z.boolean(),
  compress: z.boolean(),
  voice: z.boolean(),
  httpFallback: z.boolean(),
})

export const bootstrapInfoSchema = z.object({
  mode: z.enum(["managed", "external", "test"]),
  state: z.enum(["starting", "ready", "restarting", "error", "stopped"]),
  ready: z.boolean(),
  contract: z.literal(HERMES_DESKTOP_CONTRACT),
  wsPath: z.string().min(1),
  profile: z.string().nullable(),
  capabilities: capabilitySetSchema,
  backend: z
    .object({
      version: z.string().optional(),
      releaseDate: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
})

export const rpcErrorSchema = z.object({
  code: z.number().optional(),
  message: z.string().default("Hermes RPC failed"),
  data: z.unknown().optional(),
})

export const rawGatewayEventSchema = z
  .object({
    type: z.string().min(1),
    session_id: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough()

export const rpcFrameSchema = z
  .object({
    jsonrpc: z.literal("2.0").optional(),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().optional(),
    params: rawGatewayEventSchema.optional(),
    result: z.unknown().optional(),
    error: rpcErrorSchema.optional(),
  })
  .refine((frame) => frame.method === "event" || frame.id !== undefined, {
    message: "Invalid JSON-RPC frame",
  })

export const rawSessionRuntimeInfoSchema = z
  .object({
    branch: z.string().optional(),
    config_warning: z.string().optional(),
    credential_warning: z.string().optional(),
    cwd: z.string().optional(),
    desktop_contract: z.number().optional(),
    fast: z.boolean().optional(),
    install_warning: z.string().optional(),
    model: z.string().optional(),
    personality: z.string().optional(),
    profile_name: z.string().optional(),
    provider: z.string().optional(),
    reasoning_effort: z.string().optional(),
    running: z.boolean().optional(),
    service_tier: z.string().optional(),
    title: z.string().optional(),
    usage: z.unknown().optional(),
    version: z.string().optional(),
    yolo: z.boolean().optional(),
  })
  .passthrough()

export const rawSessionMessageSchema = z
  .object({
    role: z.enum(["assistant", "system", "tool", "user"]),
    content: z.unknown().optional(),
    text: z.unknown().optional(),
    timestamp: z.number().optional(),
    reasoning: z.string().nullable().optional(),
    reasoning_content: z.string().nullable().optional(),
    tool_call_id: z.string().nullable().optional(),
    tool_name: z.string().optional(),
    tool_calls: z.unknown().optional(),
  })
  .passthrough()

export const rawSessionSnapshotSchema = z
  .object({
    session_id: z.string().min(1),
    stored_session_id: z.string().optional(),
    session_key: z.string().optional(),
    resumed: z.string().optional(),
    message_count: z.number().int().nonnegative().optional(),
    messages: z.array(rawSessionMessageSchema).default([]),
    info: rawSessionRuntimeInfoSchema.optional(),
    inflight: z
      .object({
        user: z.string().default(""),
        assistant: z.string().default(""),
        streaming: z.boolean().default(false),
      })
      .nullable()
      .optional(),
    running: z.boolean().optional(),
    status: z.string().optional(),
  })
  .passthrough()

export const rawSessionSummarySchema = z
  .object({
    id: z.string().min(1),
    _lineage_root_id: z.string().nullable().optional(),
    parent_session_id: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    preview: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    profile: z.string().optional(),
    archived: z.boolean().optional(),
    is_active: z.boolean().optional(),
    started_at: z.number().optional(),
    last_active: z.number().optional(),
    message_count: z.number().int().nonnegative().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    tool_call_count: z.number().optional(),
  })
  .passthrough()

export const rawSessionListSchema = z.union([
  z.array(rawSessionSummarySchema),
  z.object({ sessions: z.array(rawSessionSummarySchema).default([]) }).passthrough(),
])

/**
 * REST profile aggregation is the only safe historical-list contract. Unlike
 * gateway `session.list`, every row must identify its owning profile.
 */
export const rawProfileSessionListSchema = z
  .object({
    sessions: z.array(rawSessionSummarySchema.extend({ profile: z.string().min(1) })).default([]),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    profile_totals: z.record(z.string(), z.number().int().nonnegative()).optional(),
    errors: z
      .array(z.object({ profile: z.string().min(1), error: z.string().min(1) }))
      .optional(),
  })
  .passthrough()

export const rawSessionHistorySchema = z
  .object({
    count: z.number().int().nonnegative().optional(),
    messages: z.array(rawSessionMessageSchema).default([]),
  })
  .passthrough()

/**
 * Hermes exposes persisted messages through two compatible HTTP surfaces:
 * the dashboard backend uses `messages`, while the standalone API server uses
 * OpenAI-style `data`. Normalize both envelopes before they reach the UI.
 */
export const rawSessionMessagesResponseSchema = z
  .union([
    z
      .object({
        session_id: z.string().min(1),
        messages: z.array(rawSessionMessageSchema),
      })
      .passthrough()
      .transform((response) => ({
        session_id: response.session_id,
        messages: response.messages,
      })),
    z
      .object({
        session_id: z.string().min(1),
        data: z.array(rawSessionMessageSchema),
      })
      .passthrough()
      .transform((response) => ({
        session_id: response.session_id,
        messages: response.data,
      })),
  ])

export const rawUsageSchema = z
  .object({
    calls: z.number().default(0),
    context_max: z.number().optional(),
    context_percent: z.number().optional(),
    context_used: z.number().optional(),
    cost_usd: z.number().optional(),
    input: z.number().default(0),
    output: z.number().default(0),
    total: z.number().default(0),
  })
  .passthrough()

export const rawModelPricingSchema = z
  .object({
    input: z.string().default(""),
    output: z.string().default(""),
    cache: z.string().nullable().optional(),
    free: z.boolean().optional(),
  })
  .passthrough()

export const rawModelProviderSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    is_current: z.boolean().optional(),
    models: z.array(z.string()).optional(),
    authenticated: z.boolean().optional(),
    warning: z.string().optional(),
    pricing: z.record(z.string(), rawModelPricingSchema).optional(),
    capabilities: z
      .record(
        z.string(),
        z.object({ fast: z.boolean().optional(), reasoning: z.boolean().optional() }).passthrough(),
      )
      .optional(),
  })
  .passthrough()

export const rawModelOptionsSchema = z
  .object({
    model: z.string().optional(),
    provider: z.string().optional(),
    providers: z.array(rawModelProviderSchema).default([]),
  })
  .passthrough()

export const commandPairSchema = z.tuple([z.string().min(1), z.string()])

/** Exact gateway shape returned by `commands.catalog`, normalized at the edge. */
export const commandCatalogSchema = z
  .object({
    pairs: z.array(commandPairSchema).default([]),
    categories: z
      .array(
        z
          .object({
            name: z.string().min(1),
            pairs: z.array(commandPairSchema).default([]),
          })
          .passthrough(),
      )
      .default([]),
    canon: z.record(z.string(), z.string()).default({}),
    sub: z.record(z.string(), z.array(z.string())).default({}),
    skill_count: z.number().int().nonnegative().default(0),
    warning: z.string().optional(),
  })
  .passthrough()
  .transform((catalog) => ({
    pairs: catalog.pairs,
    categories: catalog.categories.map((category) => ({
      name: category.name,
      pairs: category.pairs,
    })),
    canon: catalog.canon,
    sub: catalog.sub,
    skillCount: catalog.skill_count,
    ...(catalog.warning ? { warning: catalog.warning } : {}),
  }))

export const slashCompletionItemSchema = z
  .object({
    text: z.string(),
    display: z.string().optional(),
    meta: z.string().optional(),
  })
  .passthrough()
  .transform((item) => ({
    text: item.text,
    display: item.display ?? item.text,
    meta: item.meta ?? "",
  }))

/** Exact `complete.slash` envelope, including its authoritative replacement offset. */
export const slashCompletionResultSchema = z
  .object({
    items: z.array(slashCompletionItemSchema).default([]),
    replace_from: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .transform((result) => ({
    items: result.items,
    replaceFrom: result.replace_from ?? 0,
  }))

const commandWarningFields = {
  warning: z.string().optional(),
  notice: z.string().optional(),
}

export const commandDispatchDirectiveSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(["output", "exec", "plugin"]),
      output: z.string().optional(),
      ...commandWarningFields,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("send"),
      message: z.string(),
      ...commandWarningFields,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("skill"),
      message: z.string(),
      name: z.string().optional(),
      ...commandWarningFields,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("prefill"),
      message: z.string(),
      ...commandWarningFields,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("alias"),
      target: z.string().min(1),
      ...commandWarningFields,
    })
    .passthrough(),
])

/** `slash.exec` can return either its legacy output envelope or a dispatch directive. */
export const slashExecResponseSchema = z.union([
  commandDispatchDirectiveSchema,
  z
    .object({
      output: z.string(),
      warning: z.string().optional(),
      notice: z.string().optional(),
    })
    .passthrough(),
])

export type RawGatewayEvent = z.infer<typeof rawGatewayEventSchema>
export type RawSessionMessage = z.infer<typeof rawSessionMessageSchema>
export type RawSessionMessagesResponse = z.infer<typeof rawSessionMessagesResponseSchema>
export type RawSessionRuntimeInfo = z.infer<typeof rawSessionRuntimeInfoSchema>
export type RawSessionSnapshot = z.infer<typeof rawSessionSnapshotSchema>
export type RawCommandDispatchDirective = z.infer<typeof commandDispatchDirectiveSchema>
export type RawSlashExecResponse = z.infer<typeof slashExecResponseSchema>
