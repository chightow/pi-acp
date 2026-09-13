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
      loadSession: false,
      mcpCapabilities: { stdio: true, http: true, sse: true },
      promptCapabilities: { embeddedContext: true, image: true },
      // No sessionCapabilities advertised: we own sessions in-process,
      // one pi AgentSession per ACP sessionId.
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

export function buildSessionNewResult(sessionId: string, modelId: string) {
  return {
    sessionId,
    // Advertised selects. `model` buys KiroCrew's ADVERTISED_MODEL_SELECTION
    // capture (the only vocabulary `set_config_option("model")` accepts).
    // `mode` buys the SESSION_CONFIG permission routing: Crew asserts
    // `mode=read-only` before the first prompt and refuses the session
    // otherwise — see codex-acp precedent.
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: modelId,
        options: [{ value: modelId, name: modelId }],
      },
      {
        id: "mode",
        name: "Session Mode",
        category: "mode",
        type: "select",
        currentValue: "read-only",
        options: [
          {
            value: "read-only",
            name: "read-only",
            description: "Every tool call asks KiroCrew for permission.",
          },
        ],
      },
    ],
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
