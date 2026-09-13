/**
 * Minimal ACP (Agent Client Protocol) JSON-RPC types, shaped by what
 * KiroCrew's `acp/client.py` actually sends and reads back.
 *
 * Wire reference: `test/fixtures/acp_frames/opencode/*.jsonl` in KiroCrew —
 * numeric protocolVersion 1, `initialize` -> `session/new` -> `session/prompt`,
 * server->client `session/request_permission`, client<-server `session/update`.
 */

// ── JSON-RPC framing ──────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

// ── ACP methods ───────────────────────────────────────────────────

export const METHOD_INITIALIZE = "initialize";
export const METHOD_SESSION_NEW = "session/new";
export const METHOD_SESSION_LOAD = "session/load";
export const METHOD_SESSION_PROMPT = "session/prompt";
export const METHOD_SESSION_CANCEL = "session/cancel";
export const METHOD_SET_CONFIG_OPTION = "session/set_config_option";
export const METHOD_SET_MODE = "session/set_mode";
export const METHOD_SET_MODEL = "session/set_model";
export const METHOD_REQUEST_PERMISSION = "session/request_permission";
export const METHOD_SESSION_UPDATE = "session/update";

// ── initialize ────────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: number | string;
  clientInfo?: { name: string; version: string };
  clientCapabilities?: Record<string, unknown>;
}

export function buildInitializeResult() {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      // Slice 10: Crew resumes harness-owned sessions via `session/load`.
      // Unknown ids error (Crew falls back to `session/new`); resumed
      // sessions re-declare their MCP surface on the load params.
      loadSession: true,
      mcpCapabilities: { stdio: true, http: true, sse: true },
      promptCapabilities: { embeddedContext: true, image: true },
      // No sessionCapabilities advertised: we own sessions, one pi
      // AgentSession per ACP sessionId (slice 10: file-backed under the
      // adapter session dir so `session/load` can resume across restarts).
    },
    authMethods: [],
    agentInfo: { name: "pi-acp", version: "0.1.0" },
  };
}

// ── session/new ───────────────────────────────────────────────────

export interface McpServerStdio {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }> | Record<string, string>;
  // ACP v1 spells stdio as the untagged fallback; some writers add it.
  type?: string;
}

export interface McpServerRemote {
  name: string;
  url: string;
  type: "http" | "sse";
  headers?: Array<{ name: string; value: string }>;
}

export type McpServerDef = McpServerStdio | McpServerRemote | Record<string, any>;

export interface SessionNewParams {
  cwd: string;
  mcpServers?: McpServerDef[];
  _meta?: Record<string, any>;
}

export function buildSessionNewResult(
  sessionId: string,
  modelId: string,
  effortCurrent: string = "medium",
  modelOptions?: ModelOption[],
) {
  return {
    sessionId,
    // Advertised selects. `model` buys KiroCrew's ADVERTISED_MODEL_SELECTION
    // capture (the only vocabulary `set_config_option("model")` accepts).
    // `mode` buys the SESSION_CONFIG permission routing: Crew asserts
    // `mode=read-only` before the first prompt and refuses the session
    // otherwise — see codex-acp precedent.
    // `effort` buys kiro's reasoning-effort knob (slice 9): Crew parses
    // `configOptions` for `id=="effort"`, reads `options[].value` in ACP
    // order into the dashboard allow-list, and pushes levels back over
    // `session/set_config_option`. See EFFORT_LEVELS below for the
    // advertise-only-5 decision.
    configOptions: buildConfigOptions(modelId, "read-only", effortCurrent, modelOptions),
  };
}

/**
 * Slice 9 — effort knob parity (kiro's reasoning-effort selector).
 *
 * Single source of truth Crew-side is `src/kiro_crew/effort.py`:
 * `EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")`, ordered
 * low→max. `""` is NOT a level (means "provider default").
 *
 * Decisions (documented per brief):
 * - Advertise ONLY the 5 Crew levels, in EFFORT_LEVELS order. pi's thinking
 *   vocabulary is `off | minimal | low | medium | high | xhigh | max`
 *   (`pi --thinking` help); the overlap with Crew is exact for the 5, and
 *   `off`/`minimal` would hide reasoning Crew expects, so they are never
 *   advertised (pi may still report them as currentValue on models whose
 *   default sits outside the 5 — the selector stays the 5).
 * - `""`/absent maps to pi default: the initial `currentValue` is pi's own
 *   `thinkingLevel` for the model (global default `medium` unless a
 *   per-model override applies). `""` is never advertised and is rejected
 *   as an invalid value if sent — same fail-closed stance as slice 5's
 *   `setModel` (unknown values throw, adapter keeps serving the old level).
 * - pi clamps to model capabilities (`setThinkingLevel` → `clampThinkingLevel`;
 *   e.g. muse-spark has no `max` mapping, so `max` settles to `xhigh`). The
 *   adapter accepts any of the 5 and reports the post-clamp actual level in
 *   the follow-up `config_option_update` notification; Crew's step-down ladder
 *   (`_set_effort_config_option`) treats a rejection as "try lower", so a
 *   future per-model filter would compose without changing this contract.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isValidEffort(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as readonly string[]).includes(value);
}

function effortDisplayName(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
}

export function buildEffortConfigOption(currentValue: string) {
  return {
    id: "effort",
    name: "Effort",
    description: "Reasoning depth for this model",
    category: "effort",
    type: "select",
    currentValue,
    options: EFFORT_LEVELS.map((value) => ({ value, name: effortDisplayName(value) })),
  };
}

/** Full `configOptions` array (model + mode + effort) for `session/new` and
 *  for the `config_option_update` notification Crew's
 *  `_handle_config_option_update` consumes (full-array replace). */
/**
 * One entry of the `model` select: the full pi catalog, so Crew's picker can
 * offer (and its push can validate against) every id the adapter accepts.
 * Values are `provider/id` pairs (unambiguous when providers share a bare
 * id); names are the bare ids for a readable dropdown.
 */
export interface ModelOption {
  value: string;
  name: string;
  description?: string;
}

export function buildConfigOptions(
  modelId: string,
  mode: string,
  effortCurrent: string,
  modelOptions?: ModelOption[],
) {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: modelId,
      options:
        modelOptions && modelOptions.length > 0
          ? modelOptions.map((o) => ({
              value: o.value,
              name: o.name || o.value,
              description: o.description || "",
            }))
          : [{ value: modelId, name: modelId }],
    },
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: mode,
      options: [
        {
          value: "read-only",
          name: "read-only",
          description: "Every tool call asks KiroCrew for permission.",
        },
      ],
    },
    buildEffortConfigOption(effortCurrent),
  ];
}

/** `session/update` params for a `config_option_update` push (e.g. after a
 *  model switch rebuilds effort options). Crew replaces its whole
 *  `_acp_config_options` array and re-syncs the dashboard allow-list. */
export function buildConfigOptionUpdate(sessionId: string, configOptions: unknown) {
  return {
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions,
    },
  };
}

// ── session/prompt ────────────────────────────────────────────────

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; uri: string; title?: string; text?: string }
  | Record<string, any>;

export function promptBlocksToText(prompt: PromptBlock[] | string): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return String(prompt ?? "");
  return prompt
    .map((b) => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return (b as { text?: string }).text ?? "";
      if (b?.type === "resource") {
        const r = b as { text?: string; uri?: string };
        return r.text ?? `[resource: ${r.uri ?? "unknown"}]`;
      }
      if (b?.type === "image") return "[image]";
      return "";
    })
    .join("");
}

// ── session/update notifications (agent -> client) ────────────────

let messageSeq = 0;
export function nextMessageId(): string {
  messageSeq += 1;
  return `msg_pi_${Date.now().toString(36)}_${messageSeq}`;
}

export function agentMessageChunk(sessionId: string, messageId: string, text: string) {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: { type: "text", text },
    },
  };
}

export function toolCall(
  sessionId: string,
  toolCallId: string,
  title: string,
  kind: string,
  rawInput: Record<string, any>,
  cwd?: string,
) {
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title,
      kind,
      status: "pending",
      ...(cwd ? { locations: [{ path: cwd }] } : {}),
      rawInput,
    },
  };
}

export function toolCallUpdate(
  sessionId: string,
  toolCallId: string,
  title: string,
  kind: string,
  status: "in_progress" | "completed" | "failed",
  rawInput: Record<string, any>,
  opts: { contentText?: string; rawOutput?: any; cwd?: string } = {},
) {
  const update: Record<string, any> = {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status,
    kind,
    title,
    rawInput,
  };
  if (opts.cwd) update.locations = [{ path: opts.cwd }];
  if (opts.contentText !== undefined) {
    update.content = [{ type: "content", content: { type: "text", text: opts.contentText } }];
  }
  if (opts.rawOutput !== undefined) update.rawOutput = opts.rawOutput;
  return { sessionId, update };
}

// ── session/request_permission (agent -> client REQUEST) ──────────

export interface PermissionOption {
  optionId: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  name: string;
}

export function permissionOptions(): PermissionOption[] {
  return [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ];
}

/**
 * Crew's answer to `session/request_permission`, reduced to a verdict.
 * Accepts the ACP-spec shape (`{outcome:{outcome:"selected",optionId}}`),
 * the flat shape (`{outcome:"selected",optionId}` / `{optionId}`), and
 * anything else fail-safe as reject — an unparseable approval approves
 * nothing. optionIds are the ones we advertised (once/always/reject),
 * echoed back by Crew's approve/reject path.
 */
export function permissionVerdict(result: any): "once" | "always" | "reject" {
  try {
    const outer = result && typeof result === "object" ? result : {};
    const o = outer.outcome;
    let selected = false;
    let optionId: string | undefined;
    if (o && typeof o === "object") {
      selected = o.outcome === "selected";
      if (typeof o.optionId === "string") optionId = o.optionId;
    } else if (o === "selected") {
      selected = true;
      if (typeof outer.optionId === "string") optionId = outer.optionId;
    } else if (typeof outer.optionId === "string") {
      selected = true;
      optionId = outer.optionId;
    }
    if (!selected || !optionId) return "reject";
    const id = optionId.toLowerCase();
    if (id === "always" || id === "allow_always") return "always";
    if (id === "once" || id === "allow_once") return "once";
    return "reject";
  } catch {
    return "reject";
  }
}
