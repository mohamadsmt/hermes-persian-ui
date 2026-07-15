# Hermes Persian UI

A Persian-first, local, single-user web interface for
[Nous Research Hermes Agent](https://github.com/NousResearch/hermes-agent).
The app connects to a real Hermes gateway, streams responses, and exposes
sessions, tool activity, approvals, and other controls only when the backend
actually advertises them. An English interface is available at `/en`, while
`/fa` remains the default route with an RTL shell.

> This UI is designed to bind only to loopback. Do not expose it directly to a
> LAN or the internet.

## Requirements

- Node.js `22.22.3` (pinned in `.nvmrc`)
- pnpm `10.33.3` through Corepack
- Hermes Agent `v0.18.2` for a live connection
- A valid Hermes provider; the UI neither receives nor stores model credentials

Check the local Hermes state before installing the UI:

```sh
hermes --version
hermes status
```

This project does not change `~/.hermes` settings or the default provider.
Changes made through the model picker apply only to the active session. In
particular, `gpt-5.6-sol`/OpenAI Codex routing must be managed in Hermes
itself, not by this UI.

## Install and run

```sh
nvm use
corepack enable
corepack prepare pnpm@10.33.3 --activate
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Then open [http://127.0.0.1:3000/fa](http://127.0.0.1:3000/fa).
`pnpm dev` runs a custom Node server; invoking `next dev` directly bypasses
the WebSocket relay and Hermes lifecycle management and is not supported.

For a production build:

```sh
pnpm build
pnpm start
```

### Managed mode (default)

With `HERMES_BACKEND_MODE=managed`, the app server starts the following as a
child process on loopback only, reads its assigned port from the readiness
signal, and relays WebSocket traffic at `/api/hermes/ws`:

```sh
hermes serve --host 127.0.0.1 --port 0
```

The random upstream token remains only in server memory. During shutdown, only
the process created by this app is stopped; independent Hermes daemons and
sessions are not touched.

### External mode

If a gateway is already running, configure `.env.local` as follows:

```dotenv
HERMES_BACKEND_MODE=external
HERMES_WS_URL=ws://127.0.0.1:9119/api/ws
HERMES_WS_TOKEN=
HERMES_BASE_URL=http://127.0.0.1:9119
HERMES_API_KEY=
```

Tunnel a remote gateway to local loopback; for example:

```sh
ssh -N -L 9119:127.0.0.1:9119 user@example-host
```

Keep `HERMES_WS_URL` set to `ws://127.0.0.1:9119/api/ws`. Do not use
`ws://public-host` or a public UI bind. TLS termination and authentication
for the remote endpoint remain the operator's responsibility.

## Environment variables

| Variable | Default/example | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | UI bind address; non-loopback values are intentionally rejected |
| `PORT` | `3000` | UI port |
| `HERMES_BACKEND_MODE` | `managed` | `managed` or `external` |
| `HERMES_COMMAND` | `hermes` | Trusted executable in managed mode |
| `HERMES_WS_URL` | `ws://127.0.0.1:9119/api/ws` | Gateway URL in external mode |
| `HERMES_WS_TOKEN` | empty | Server-side credential for the external WebSocket |
| `HERMES_BASE_URL` | `http://127.0.0.1:9119` | Root URL for the external HTTP fallback |
| `HERMES_API_KEY` | empty | Server-side API key for the external HTTP fallback |
| `HERMES_PROFILE` | empty | Initial Hermes profile; empty uses the default profile |

Keep secrets only in `.env.local`. These variables must not use a
`NEXT_PUBLIC_` prefix and must never be written to localStorage, URLs, or
logs.

## Connection architecture

The `HermesTransport` boundary separates React from the wire format. The
primary transport is JSON-RPC 2.0 over WebSocket with a minimum desktop
contract of `v2`. Newer monotonic Hermes contracts—including `v3` in the
current `v0.18.2` patch—are accepted as supersets; the independent
bootstrap/BFF contract remains `v2`. Incoming messages are validated with
runtime schemas and then converted into a shared event model. The stored
session ID is stable in the URL; the runtime ID can change after reconnecting.

In external mode, negotiation follows this order:

1. TUI Gateway WebSocket
2. `/v1/capabilities` and Runs/SSE, when advertised by the backend
3. Responses API with SSE
4. Chat Completions with SSE as a compatibility fallback

Endpoint availability is never guessed. A JSON-RPC `method not found` error
also disables the relevant capability. Unsupported controls are hidden or
disabled with a clear reason; no decorative button without a real endpoint is
present in the production path. SSE passes through the BFF without extra
buffering, and cancellation uses `AbortController`. Event, request, tool,
and connection-epoch IDs prevent duplicate deltas after reconnecting; a prior
prompt is never resubmitted automatically.

In HTTP-only mode, the UI uses a temporary, page-local conversation to retain
context. It runs Runs with `POST /v1/runs`, streams with
`GET /v1/runs/:id/events`, and stops with `POST /v1/runs/:id/stop`. This
conversation cannot be resumed after a refresh. Session CRUD, tool prompts,
approvals, attachments, and other controls that lack a safe HTTP fallback are
intentionally disabled. Responses and Chat Completions provide only text
streaming and cancellation for that request.

Public app routes:

- `/fa` and `/en`: chat home with the actual locale and direction
- `/fa/c/:storedSessionId` and `/en/c/:storedSessionId`: persistent session
- `/fa/settings` and `/en/settings`: non-sensitive UI settings
- `/api/hermes/bootstrap`: health and capability bootstrap without credential exposure
- `/api/hermes/ws`: same-origin gateway relay
- `/api/hermes/sessions?profile=…`: read-only session list for one profile
  from `/api/profiles/sessions`; `all`, repeated profiles, and rows with no
  profile label are rejected

Historical sessions are intentionally not read from RPC `session.list`,
because that method is limited to the gateway's profile and cannot guarantee
profile ownership for every row. The BFF sends only one valid profile name to
Hermes, removes aggregate browser filters, and fails the entire response
closed—rejecting the entire response—if it cannot read `state.db` or receives
even one row from another profile. When the profile changes, the query cache,
active session, and prior
transcript are also isolated from the UI. Drafts, the send queue, attachments,
model overrides, and artifacts are namespaced in memory with the combined
profile and `storedSessionId` key; this namespace does not alter the URL or
the identifier sent to Hermes.

Historical rename and delete operations also go through the BFF to the real
Hermes REST API: `PATCH /api/sessions/:id` with the profile in the body and
`DELETE /api/sessions/:id?profile=…`. To prevent deleting database state
under another runtime, deletion is not offered for a row active in a different
runtime; the current runtime is closed first and then deleted from the same
profile.

## Persian and BiDi strategy

Shell direction comes from the locale, while every paragraph, heading, list
item, quote, and table cell independently determines its direction with
`dir="auto"`. `unicode-bidi: plaintext` and `text-align: start` let the
first strong character determine each block. URLs, paths, model IDs, acronyms,
and inline code use semantic isolation; no hidden LRM/RLM or embedding is
added to source text.

Code, terminals, JSON/YAML, diffs, stack traces, and technical URLs are always
LTR. Copy uses the stored raw source rather than decorated DOM `textContent`,
so the clipboard exactly matches the logical input. The fixed ten-case corpus
in `tests/fixtures/bidi.ts` covers punctuation, slashes, colons, percentages,
currencies, paths, independent paragraphs, links, and code between two RTL
paragraphs.

Fonts are self-hosted: Vazirmatn Variable for Persian, Inter Variable for
Latin text, and JetBrains Mono Variable for technical content. Code, paths,
and URLs are never localized or converted to Persian digits.

## Security

- The server accepts only loopback hosts and same-origin Origins for HTTP/WS.
- Hermes credentials remain server-side only and never reach the bootstrap
  response or browser bundle.
- Secret request bodies, sudo passwords, and tokens are never logged or persisted.
- Markdown is sanitized; external links use `noopener noreferrer`.
- Unknown HTML is shown only in an iframe without `allow-scripts` or
  `allow-same-origin`. Raw PDFs do not receive a fabricated preview.
- CSP, security headers, frame/upload limits, and redaction are enforced at the BFF.
- The relay frame limit is 70 MiB, allowing a 50 MiB raw PDF after base64 and
  JSON-RPC overhead; it remains a hard cap. Raw recordings in the UI are
  limited to 25 MiB and JSON transcription bodies to 35 MiB, supporting
  base64 expansion without raising the raw file limit.
- `HERMES_TEST_MODE=1` is rejected before startup when
  `NODE_ENV=production`.
- YOLO is off by default and can be enabled only after a warning when a real
  command exists.

When reviewing a bundle, treat any change that adds a secret or
`NEXT_PUBLIC_HERMES_*` as a security blocker.

## Tests

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm test:visual
pnpm build
pnpm smoke:hermes
```

`pnpm test:e2e` runs a deterministic, test-only backend with
`HERMES_TEST_MODE=1`; the mock never enters the production bundle. Review
visual baselines whenever an intentional UI change is made, using the command
documented in [`docs/testing.md`](docs/testing.md). By default, the live
smoke test checks only connectivity, route discovery, temporary-session
creation, and cleanup; it sends no prompt. Running a low-cost and potentially
billable turn requires this explicit opt-in:

```sh
HERMES_SMOKE_ALLOW_BILLING=1 pnpm smoke:hermes
```

That document also contains the cleanup details and acceptance criteria.

## Troubleshooting

### The page remains on “Connecting”

```sh
hermes --version
hermes serve --status
hermes status
```

In managed mode, confirm that `HERMES_COMMAND` is available in the
environment that runs `pnpm dev`. In external mode, check the URL, tunnel,
and token. A `protocol incompatible` error usually means the installed Hermes
desktop contract is below `v2` or no contract is advertised; unknown payloads
are never interpreted by force.

### Authentication error

Correct the credentials in `.env.local` and restart the server. Never enter
the token in DevTools or localStorage. Model-provider login happens in Hermes
itself; for example, OpenAI Codex should report as valid in `hermes status`.

### HTTP fallback or voice is unavailable

These capabilities are capability-gated. A disabled API Server or voice
provider is not a failure of primary chat; the WebSocket gateway remains the
main path.

### An attachment is rejected

Check the file type and size. The backend may support only images; in that
case, the UI does not pretend that a general file or PDF was attached.

### The build succeeds, but WebSocket fails in production

Run the app with `pnpm start`, not `next start`. A local reverse proxy must
also forward WebSocket upgrades for `/api/hermes/ws` and leave the Origin
unchanged.

## Known limitations

- Multi-user distribution, UI login, and direct network binding are not part
  of this version.
- Pin/archive, pagination, arbitrary file upload, voice, reasoning options,
  and the HTTP fallback appear only when the installed backend advertises them.
- PDFs can be attached without a secure built-in viewer, but they have no
  in-app preview.
- The app does not manage global Hermes configuration, provider routing, cron
  jobs, MCP, or plugins.
- Missing optional capabilities are not replaced with a fake UI and remain
  visible in the connection/settings report.

## License and data

This project's code is released under the [MIT License](LICENSE). Fontsource
installs Vazirmatn, Inter, and JetBrains Mono packages with their upstream
licenses. Transcripts and artifacts come from Hermes; the UI stores only
non-sensitive preferences such as theme and locale in the browser.
