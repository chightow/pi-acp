# pi-acp — ACP adapter for pi

Lets KiroCrew drive `pi` over the Agent Client Protocol. Same pattern as
`codex-acp` / `claude-agent-acp`: the harnessed CLI doesn't speak ACP, so a
Node stdio adapter translates. JSON-RPC frames go over stdin/stdout, one per
line; `U+2028`/`U+2029` are valid inside JSON so framing splits on `\n` only.

## How it works

One ACP session is one pi `AgentSession`, plus its MCP connections and a
permission gate, all held in-process (`src/pi-session.ts`):

- **Streaming demux** — pi's typed stream events map to ACP chunks:
  `text_delta` → `agent_message_chunk`, `thinking_delta` →
  `agent_thought_chunk`. `*_start`/`*_end` carry no text and are ignored; a
  role-gated `message_end` fallback covers transports that never emit deltas,
  so thinking never leaks into chat and text is never duplicated.
- **Permission gate** — a pi `tool_call` hook extension blocks *every* tool
  call (builtin + bridged) on Crew's `session/request_permission`. pi has no
  approval primitive of its own, so the gate is the source of truth for both
  ACP `tool_call` frames and the permission bridge. Deny (or an unparseable
  verdict, or a cancelled turn) fails safe to reject; `allow_always` is cached
  per-session. Request handling is concurrent — a prompt turn never blocks a
  permission answer arriving on the same stdin.
- **MCP bridge** (`src/mcp-bridge.ts`) — Crew's `mcpServers[]` mount as pi
  custom tools named `mcp__<server>__<tool>`, connected before the pi session
  boots (pi snapshots its tool list at creation). MCP JSON Schema passes
  through to TypeBox losslessly. Crew's member-dispatch entry (the
  `kirocrew-dashboard` session-control server) rides the same mount — its
  identity env arrives byte-identical and its verbs ask permission like any
  other tool.
- **Usage** — one flat `usage_update` per turn (`used`/`size` from pi's own
  `getContextUsage`, cumulative USD `cost` once any provider reports one),
  plus flat turn-scoped token counts on the prompt response.
- **Steer** — kiro's `_session/steer` extension: queued only while a turn
  streams, `<user_message>` framing stripped, injected via
  `sendUserMessage(..., {deliverAs: "steer"})`; `steering_queued` /
  `steering_consumed` notifications ride `session/update`.
- **Compact** — a `/compact [context]` prompt runs pi `compact()` instead of
  `prompt()`, ACKs `end_turn`, and emits `started` + terminal
  `completed|failed` on `_kiro.dev/compaction/status` plus a fresh
  `usage_update`. Automatic threshold/overflow compactions ride the same
  frames; a `started` without a terminal settles at turn end.
- **Sessions** — adapter sessions persist under `<agentDir>/sessions/pi-acp/`
  (`PI_ACP_SESSION_DIR` overrides), namespaced away from interactive
  sessions. `session/load` reopens a session by id — model, thinking level,
  and messages restored — with a fresh permission cache and steering ledger,
  so a resumed session re-asks. `session/new` ids never repeat across
  restarts; unknown ids and cwd mismatches error fail-closed.
- **Effort** — `session/new` advertises an `effort` selector (`low→max`);
  `session/set_config_option{effort}` maps onto pi's `setThinkingLevel`,
  fail-closed (unknown values rejected, old level keeps serving), with a
  full-array rebuild notification on model switches.

Project trust is forced off: `.pi/` project extensions/packages never
pre-approve past the gate.

## Protocol surface

Requests handled: `initialize`, `session/new`, `session/load`, `session/prompt`,
`session/cancel`, `session/set_config_option`, kiro's `_session/steer`.
Anything else answers `-32601` (unknown method); `session/new` takes an
optional `mcpServers` array. Advertised: `loadSession: true`, MCP over
stdio/http/sse, embedded-context + image prompts, and `model` / `mode`
selectors (`model` carries the runnable catalog as `provider/id` values -- only
providers pi's own auth check passes, so Crew's picker offers every id
`set_config_option` accepts and nothing that would die at prompt time; `mode` is always
`read-only` — every tool call asks).

Agent → client traffic: `session/update` notifications (message/thought
chunks, tool calls + updates, steering, `usage_update`,
`_kiro.dev/compaction/status`) and `session/request_permission` requests
with `out-N` string ids (no collision with Crew's numerics, 30 min ceiling
then fail-safe).

`PI_ACP_ECHO=1` swaps the pi backend for an in-memory echo — a keyless
wire-test harness for the framing and handshake.

## Run it

```sh
npm run build          # tsc → dist/
node dist/index.js     # speak ACP on stdio (normally spawned by Crew)
```

## Test it

```sh
node test/handshake.mjs   # keyless framing/handshake gate (needs PI_ACP_ECHO=1)
node test/prompt.mjs       # prompt demux, usage shapes
node test/permission.mjs   # gate: ask / deny / allow_always
node test/mcp-bridge.mjs   # bridge via test/toy-mcp-server.mjs
node test/steer.mjs        # mid-turn steer + notifications
node test/compact.mjs      # /compact statuses + meter reset
node test/effort.mjs       # effort advertise / set / reject
node test/model-list.mjs   # usable-model catalog advertise / accept / reject ($0, no prompt)
node test/load.mjs         # two-process resume: persist, reload, continue
node test/member-dispatch.mjs   # dispatch-shaped mount + gate (via dispatch-mcp-server.mjs)
```

Live tests need a tool-capable model (flash hallucinates tool calls — never
use it); the cheap pick is:

```sh
PI_ACP_MODEL="opencode-go/muse-spark-1.3-contributor" node test/permission.mjs
```

`PI_ACP_MODEL` (`provider/id` or bare id) is the dev-time seam for model
choice; Crew drives it from `session/set_config_option` instead of env.
`test/capture-*-live.mjs` scripts record live wire captures for Crew's frame
corpus (`test/fixtures/acp_frames/pi/` on the Crew side).

`PI_ACP_DEBUG_EVENTS=1` logs pi session event types (first 8 of each) to
stderr while developing.

## Auth model

BYO keys (`ANTHROPIC_API_KEY`, …) via pi's own auth — stored in
`~/.pi/agent`, never env keys. No Kiro subscription.
