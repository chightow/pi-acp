# pi-acp — ACP adapter for pi

Lets KiroCrew drive `pi` over the Agent Client Protocol (same pattern as
`codex-acp` / `claude-agent-acp`: the harnessed CLI doesn't speak ACP, so a
Node stdio adapter translates).

## Vertical slices

| Slice | Goal | Done when |
|---|---|---|
| 1 — wire handshake | `initialize → session/new → session/prompt` echo over stdio (`PI_ACP_ECHO=1`) | ✅ PASS — keyless gate |
| 2 — pi prompt | Real `pi` turn via SDK `createAgentSession()`; typed demux: `text_delta→agent_message_chunk`, `thinking_delta→agent_thought_chunk`, role-gated `message_end` fallback | ✅ PASS — chat exactly `slice2-ok`, thought separate, no user leak |
| 3 — permission gate | `pi.on("tool_call")` blocks on Crew's `session/request_permission` | Every tool asks; deny blocks fail-safe; `allow_always` cached per-session |
| 4 — MCP bridge | Crew's `mcpServers[]` mounted as `mcp__srv__tool` pi tools | ✅ PASS — toy stdio server listed, called through the gate, env array delivered |
| 5 — Crew onboarding | `ACP_BACKEND_PI` in `backends.py` + probe + mirror + host contract | ✅ SELECTABLE — 5a dormant (vocab/auth/contract/corpus), 5b live (spawn+probe+PiMirror+SESSION_CONFIG routing, `NOT_SHIPPED` clear) |
| 6 — usage_update | One `usage_update` per turn (flat `used`/`size` from pi's own `getContextUsage`, cumulative USD `cost` once a provider reports any) + flat turn-scoped token counts on the prompt response | ✅ PASS — `test/slice2-pi-prompt.mjs` pins both shapes; live corpus `test/fixtures/acp_frames/pi/usage.jsonl` (Crew) |
| 7 — steer | kiro's `_session/steer` mid-turn extension: `{queued:true}` only while a turn streams, `<user_message>` framing stripped, injected via pi's `sendUserMessage(..., {deliverAs:"steer"})`; `steering_queued`/`steering_consumed` notifications ride `session/update` like kiro's | ✅ PASS — `test/slice7-steer.mjs` (queued + both notifications + steered reply inside the same in-flight turn); live corpus `test/fixtures/acp_frames/pi/steer.jsonl` (Crew) |
| 9 — effort knob | kiro's reasoning-effort selector parity: `session/new` advertises `effort` (`low→max`, 5 Crew levels in order) with pi's current thinking level; `session/set_config_option{effort}` maps onto pi's `setThinkingLevel` (unknown values rejected fail-closed, old level kept); model switches rebuild the full `configOptions` array via `config_option_update` | ✅ PASS — `test/slice9-effort.mjs` (advertise order + set round-trip via notification + invalid rejected + model-switch rebuild); pi clamps to model capabilities (e.g. `max`→`xhigh` on muse-spark), `off`/`minimal` never advertised, `""` maps to pi default |

Slices 1–6 ✅ PASS. Slice 3 needs `PI_ACP_MODEL` naming a tool-capable
model (flash hallucinates tool calls) — muse-spark is the cheap test pick:

```sh
PI_ACP_MODEL="opencode-go/muse-spark-1.3-contributor" node test/slice3-permission.mjs
```

`PI_ACP_MODEL` (`provider/id` or bare id) is the dev-time seam for model
choice; Crew drives it from `session/set_config_option` instead of env. |

Rule: no slice widens the previous slice's contract. Slice 1's framing,
`-32601` honesty, and `mode=read-only` advertisement are frozen.

## Slice 1 — run it

```sh
npm run build
node test/slice1-handshake.mjs   # spawns dist/index.js, runs Crew handshake
```

## Auth model (applies from slice 2 on)

BYO keys (`ANTHROPIC_API_KEY`, …) via pi's own auth. No Kiro subscription.
Project trust forced off — `.pi/` project packages never pre-approve past
the gate (the Claude `settings.json` injection lesson).
