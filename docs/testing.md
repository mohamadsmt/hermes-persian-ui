# Test contract

The browser suite exercises the application through the same BFF and
`HermesTransport` boundary as production. `HERMES_TEST_MODE=1` selects a
deterministic, test-only backend; it must never be accepted by a production
build or enabled by a browser-controlled value. The server enforces this at
runtime: `HERMES_TEST_MODE=1` with `NODE_ENV=production` aborts startup.

## Stable DOM contract

Playwright uses accessible roles for user-visible controls and the following
`data-testid` values only where role/name selectors would be ambiguous or
language-dependent:

| Test id | Contract |
| --- | --- |
| `app-shell` | Top-level authenticated/local application shell |
| `connection-status` | Current backend connection state |
| `session-list` | Session navigation collection |
| `session-item` | One session; expose its stable id as `data-session-id` |
| `new-session` | Creates a session |
| `session-search` | Filters the visible sessions |
| `/api/hermes/sessions?profile=…` | Fail-closed, single-profile historical list BFF |
| `transcript` | Scroll container for the active transcript |
| `message` | One logical message; expose `data-role` |
| `message-content` | Markdown renderer root containing raw-copy metadata |
| `bidi-block` | Independently directed Markdown block |
| `code-block` | LTR fenced technical content |
| `copy-code` | Copies the exact logical fenced-code source |
| `copy-message` | Copies the exact raw message source, without visual markers |
| `composer` | Composer region; its descendant `textarea` is the prompt editor |
| `send-message` | Sends the current draft |
| `stop-run` | Interrupts the active run |
| `tool-card` | Tool activity; expose `data-status` |
| `approval-dialog` | Active approval request |
| `approval-approve` / `approval-deny` | Approval responses |
| `model-picker` | Session-scoped model picker |
| `attach-file` | Attachment affordance |
| `artifact-rail` | Preview/tool/artifact region |
| `theme-toggle` | Light/dark/system control |
| `locale-switcher` | Locale control |

Changing CSS classes or Persian copy must not break this contract. If an
element has a unique semantic role and accessible name, prefer that role over
adding another test id.

## Deterministic transport scenarios

The fixture recognizes scenario prompts prefixed with `__TEST__:`. They are
not user-facing commands and exist only while `HERMES_TEST_MODE=1`:

- `__TEST__:bidi` returns the canonical corpus from `tests/fixtures/bidi.ts`.
- `__TEST__:tool` emits tool start, progress, and completion before prose.
- `__TEST__:tool-running-artifact` holds a tool at 42% and emits a real code
  artifact for the running-tool and preview-rail visual baseline.
- `__TEST__:approval` emits an approval request and waits for a response.
- `__TEST__:slow` streams until the client interrupts it.
- `__TEST__:attachment` acknowledges a deterministic text attachment.

All IDs and timestamps are fixed. Events carry stable IDs so reconnect and
deduplication behavior can be asserted. The fixture records requests in
memory only; a test-only cookie isolates its reconnect-persistent state for
each Playwright context, including parallel workers.

## Visual snapshots

Run `pnpm test:visual` to compare committed baselines. Update them only after
reviewing the rendered punctuation, paths, parentheses, currency, percent,
code direction, desktop/mobile overflow, and focus states:

```sh
pnpm exec playwright test --grep @visual --update-snapshots
```

Snapshot updates are product changes and should be reviewed like source code;
do not approve them only because pixel output changed.

## Live smoke boundary

The deterministic suite does not prove backend compatibility. The default
live smoke is connectivity-only: it starts a temporary real Hermes session but
does not submit a prompt. It must:

1. confirm Hermes `v0.18.2` or report the detected version;
2. verify BFF contract `v2` and an upstream desktop contract of at least `v2`;
3. read profiles, capabilities, and model options;
4. confirm the protected active route remains `gpt-5.6-sol` on OpenAI Codex;
5. create a uniquely named temporary session;
6. close/delete only that temporary session; and
7. redact credentials and secret prompt bodies from all output.

Run it only against a trusted loopback endpoint:

```sh
pnpm smoke:hermes
```

To opt in to one low-cost, potentially billable prompt and require at least
one delta plus a terminal event, run:

```sh
HERMES_SMOKE_ALLOW_BILLING=1 pnpm smoke:hermes
```

By default the command owns a temporary loopback BFF and managed Hermes child,
so it neither depends on nor disturbs the normal UI port. To target an already
running UI instead:

```sh
HERMES_SMOKE_UI_URL=http://127.0.0.1:3040 pnpm smoke:hermes
```

To bypass the UI/BFF and test a gateway directly, provide the normal
server-side gateway variables. A token is appended only in process memory and
is redacted from output:

```sh
HERMES_SMOKE_DIRECT=1 \
HERMES_WS_URL=ws://127.0.0.1:9119/api/ws \
HERMES_WS_TOKEN=... \
pnpm smoke:hermes
```

The safety and expectation variables are:

| Variable | Meaning |
| --- | --- |
| `HERMES_SMOKE_ALLOW_BILLING=1` | Submit exactly one constrained prompt; absent means connectivity-only |
| `HERMES_SMOKE_UI_URL` | Use an already-running UI instead of an owned ephemeral BFF |
| `HERMES_SMOKE_DIRECT=1` | Connect directly to `HERMES_WS_URL` |
| `HERMES_SMOKE_ALLOW_REMOTE=1` | Permit a non-loopback target; only use with a trusted tunnel/endpoint |
| `HERMES_SMOKE_EXPECT_VERSION` | Expected version substring; default `0.18.2` |
| `HERMES_SMOKE_EXPECT_MODEL` | Expected active model; default `gpt-5.6-sol` |
| `HERMES_SMOKE_EXPECT_PROVIDER` | Expected active provider; default `openai-codex` |
| `HERMES_SMOKE_RPC_TIMEOUT_MS` | RPC timeout, 1,000–600,000 ms |
| `HERMES_SMOKE_TURN_TIMEOUT_MS` | Opt-in turn timeout, 1,000–600,000 ms |

Cleanup always attempts both `session.close` and `session.delete` for the exact
temporary stable ID. Hermes may report method code `4007` for an empty draft
that was never persisted; this is accepted only in connectivity-only mode.
Every other cleanup failure prints the stable ID so the operator can remove it
manually. An unavailable audio provider or optional HTTP fallback is a reported
capability limitation, not a failure of the WebSocket smoke.
