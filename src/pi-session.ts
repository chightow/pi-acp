/**
 * One ACP session = one pi AgentSession + its MCP connections + permission gate.
 *
 * Design notes (see repo README for the full contract):
 * - The gate extension (`pi.on("tool_call")`) is the source of truth for
 *   ACP `tool_call` frames AND the `session/request_permission` bridge.
 *   pi has no approval primitive of its own — tools just run — so a naive
 *   RPC wrapper would bypass Crew governance entirely.
 * - Crew MCP servers are bridged as pi custom tools (`mcp__srv__tool`).
 *   pi ships no built-in MCP, so without this Crew's own tools are absent.
 * - Project trust is forced off (`resolveProjectTrust: false`): `.pi/`
 *   project extensions/packages must not pre-approve past the gate —
 *   the Claude `.claude/settings.json` injection lesson.
 */
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { McpServerDef } from "./acp.js";
import { EFFORT_LEVELS } from "./acp.js";
import {
  callBridgedTool,
  closeMcpConnection,
  connectMcpServer,
  type BridgedTool,
  type McpConnection,
} from "./mcp-bridge.js";
import { PermissionGate, kindForTool } from "./permission.js";

export interface SessionCallbacks {
  /** Send `session/update` notification to the ACP client. */
  notifyUpdate: (update: unknown) => void;
  /**
   * Send a `_kiro.dev/compaction/status` notification (kiro-cli's method
   * shape: `params.status.type` started|completed|failed, human text on
   * top-level `params.summary`). Rides its own method, NOT `session/update`
   * — Crew's dispatch classifies compaction off the method, like kiro-cli.
   */
  notifyCompaction: (type: "started" | "completed" | "failed", summary: string) => void;
  /** Ask the ACP client for permission; resolves to Crew's verdict. */
  requestPermission: (params: {
    toolCallId: string;
    title: string;
    kind: string;
    rawInput: Record<string, any>;
  }) => Promise<"once" | "always" | "reject">;
}

let toolSeq = 0;
function nextToolCallId(): string {
  toolSeq += 1;
  return `call_pi_${Date.now().toString(36)}_${toolSeq}`;
}

/**
 * Typed pi stream events (observed off the wire):
 * - assistantMessageEvent.type === "text_delta" -> agent text (agent_message_chunk)
 * - assistantMessageEvent.type === "thinking_delta" -> reasoning (agent_thought_chunk)
 * - *_start/*_end carry no new text and are ignored (message_end fallback below
 *   covers transports that never emit deltas).
 * Everything else is ignored: an untyped `delta`/`text` read would leak
 * thinking into chat or duplicate text_end snapshots as new text.
 */
function extractStreamEvents(event: any): { text: string[]; thought: string[] } {
  const out = { text: [] as string[], thought: [] as string[] };
  try {
    const ame = event?.assistantMessageEvent;
    if (ame && typeof ame.delta === "string" && ame.delta) {
      if (ame.type === "text_delta") out.text.push(ame.delta);
      else if (ame.type === "thinking_delta") out.thought.push(ame.delta);
    }
  } catch {
    /* ignore malformed events */
  }
  return out;
}

/**
 * Full assistant text at message_end — fallback when zero deltas streamed
 * this turn. Role-gated (user replays must never emit) and text-blocks-only
 * (thinking blocks ride agent_thought_chunk, never chat).
 */
function extractFinalText(event: any): string {
  try {
    if (event?.type !== "message_end") return "";
    if (event?.message?.role !== "assistant") return "";
    const content = event?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((b: any) => b?.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("");
    }
  } catch {
    /* ignore */
  }
  return "";
}

export interface TurnTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PromptResult {
  stopReason: string;
  streamedText: string;
  /** Turn-scoped token counts, or null when the provider reported no usage. */
  turnUsage: TurnTokenUsage | null;
}

export class PiSession {
  readonly sessionId: string;
  readonly cwd: string;
  private piSession: any = null;
  private mcpConns: McpConnection[] = [];
  private bridgedByPiName = new Map<string, { conn: McpConnection; tool: BridgedTool }>();
  private gate: PermissionGate;
  private cb: SessionCallbacks;
  private cancelled = false;
  private streamingText = "";
  private modelRuntime: any = null;
  /** Turn-scoped token counts accumulated from this turn's assistant messages. */
  private turnUsage: TurnTokenUsage | null = null;
  /** Session-cumulative billing cost in USD, from assistant message usage. */
  private sessionCost = 0;
  /** Steers injected into the running turn, awaiting pi's steering-drain signal. */
  private steerPending: string[] = [];
  /**
   * Set while a compaction (manual or automatic) has started without its
   * terminal. A turn that ends with this still set settles it (see
   * settleCompaction): only `end_turn` may synthesize `completed`.
   */
  private compactionPending = false;

  constructor(sessionId: string, cwd: string, cb: SessionCallbacks) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.cb = cb;
    this.gate = new PermissionGate(async (p) =>
      this.cb.requestPermission({
        toolCallId: p.toolCallId,
        title: p.title,
        kind: p.kind,
        rawInput: p.rawInput,
      }),
    );
  }

  /** Current model id for the `model` configOption display. Best-effort. */
  modelId(): string {
    try {
      const m = this.piSession?.model;
      if (m && typeof m.id === "string") return m.id;
    } catch {
      /* ignore */
    }
    return "pi-default";
  }

  /**
   * Slice 9 — current reasoning-effort level (pi `thinkingLevel`).
   * Falls back to pi's global default (`medium`) before boot.
   */
  effort(): string {
    try {
      const level = this.piSession?.thinkingLevel;
      if (typeof level === "string" && level) return level;
    } catch {
      /* ignore */
    }
    return "medium";
  }

  /** Alias for `effort()` — pi SDK vocabulary. */
  thinkingLevel(): string {
    return this.effort();
  }

  /** Levels advertised in the `effort` configOption: the 5 Crew levels in
   *  order (see EFFORT_LEVELS in acp.ts for why `off`/`minimal` stay out). */
  availableEffortLevels(): string[] {
    return [...EFFORT_LEVELS];
  }

  /** pi-native capability list for the current model (may be narrower than
   *  the advertised 5 — e.g. muse-spark lacks `max`). Informational; the
   *  adapter advertises the static 5 and lets pi clamp. */
  availableThinkingLevels(): string[] {
    try {
      const levels = this.piSession?.getAvailableThinkingLevels?.();
      if (Array.isArray(levels)) return [...levels];
    } catch {
      /* ignore */
    }
    return [...EFFORT_LEVELS];
  }

  /**
   * Slice 9 — set reasoning effort. Validates against EFFORT_LEVELS
   * (unknown → throw, caller keeps serving the old level — the slice-5
   * `setModel` fail-closed precedent; message mirrors claude-agent-acp's
   * `Invalid value for config option effort: <level>` so Crew's step-down
   * ladder recognizes it as a value rejection). On success pi clamps to
   * model capabilities internally; returns the ACTUAL post-clamp level.
   */
  setEffort(level: string): string {
    if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
      throw new Error(`Invalid value for config option effort: ${String(level)}`);
    }
    if (!this.piSession) throw new Error(`pi session not started`);
    this.piSession.setThinkingLevel(level);
    return this.effort();
  }

  async start(mcpServers: McpServerDef[]): Promise<void> {
    // 1. Connect MCP servers first so their tools exist before pi boots
    //    (pi snapshots the tool list at session creation).
    for (const def of mcpServers ?? []) {
      const conn = await connectMcpServer(def);
      if (conn) {
        this.mcpConns.push(conn);
        for (const t of conn.tools) {
          this.bridgedByPiName.set(t.piName, { conn, tool: t });
        }
      }
    }

    // 2. Build pi custom tools for bridged MCP tools. Execute() just runs —
    //    gating happens in the tool_call hook for ALL tools uniformly.
    const self = this;
    const customTools = [...this.bridgedByPiName.entries()].map(([piName, { conn, tool }]) => ({
      name: piName,
      label: `${tool.serverName}/${tool.remoteName}`,
      description: tool.description,
      // Without this the tool is omitted from Available tools and the model
      // never reaches for it — the whole bridge would be silent.
      promptSnippet: `${piName}: ${tool.description}`,
      parameters: toTypeBox(tool.inputSchema),
      async execute(toolCallId: string, params: any) {
        const { contentText, raw } = await callBridgedTool(conn, tool.remoteName, params ?? {});
        return {
          content: [{ type: "text", text: contentText || "(empty result)" }],
          details: { mcpServer: tool.serverName, mcpTool: tool.remoteName, raw },
        };
      },
    }));

    // 3. Gate extension: blocks every tool (builtin + bridged) on Crew.
    //    Emits ACP tool_call frames as the source of truth.
    const gateExtension = (pi: any) => {
      pi.on("tool_call", async (event: any) => {
        const toolName: string = event.toolName ?? "unknown";
        const input: Record<string, any> =
          event.input && typeof event.input === "object" ? event.input : {};
        const toolCallId: string =
          typeof event.toolCallId === "string" ? event.toolCallId : nextToolCallId();
        const kind = kindForTool(toolName);

        self.cb.notifyUpdate({
          sessionId: self.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind,
            status: "pending",
            locations: [{ path: self.cwd }],
            rawInput: input,
          },
        });
        self.cb.notifyUpdate({
          sessionId: self.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            kind,
            title: toolName,
            locations: [{ path: self.cwd }],
            rawInput: input,
          },
        });

        const verdict = await self.gate.check(self.sessionId, toolCallId, toolName, input, kind);
        if (verdict.allowed) return undefined;
        self.cb.notifyUpdate({
          sessionId: self.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "failed",
            kind,
            title: toolName,
            rawInput: input,
            content: [
              { type: "content", content: { type: "text", text: verdict.reason ?? "Denied" } },
            ],
          },
        });
        return { block: true as const, reason: verdict.reason ?? "Denied by operator" };
      });

      pi.on("tool_execution_end", async (event: any) => {
        const toolCallId: string =
          typeof event.toolCallId === "string" ? event.toolCallId : "unknown";
        const toolName: string = event.toolName ?? "tool";
        const result = event.result;
        const text = resultToText(result);
        self.cb.notifyUpdate({
          sessionId: self.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: event.isError ? "failed" : "completed",
            kind: kindForTool(toolName),
            title: toolName,
            rawInput: {},
            content: [{ type: "content", content: { type: "text", text: text } }],
          },
        });
      });
    };

    const agentDir = process.env.PI_AGENT_DIR ?? `${process.env.HOME ?? "~"}/.pi/agent`;
    // Two-phase creation so the model id resolves against the runtime before
    // the session boots. PI_ACP_MODEL selects `provider/id` (or a bare id
    // searched across providers); unset means pi's configured default.
    // Slice 5 will drive this from session/set_config_option instead of env.
    const services = await createAgentSessionServices({
      cwd: this.cwd,
      agentDir,
      resourceLoaderOptions: {
        extensionFactories: [{ name: "pi-acp-gate", factory: gateExtension, hidden: true }],
      },
      // Force project distrust: never auto-load project extensions/packages
      // as trusted. Operator can still trust interactively elsewhere; the
      // ACP session itself never inherits project-granted tools.
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => false },
    });
    this.modelRuntime = services.modelRuntime;
    const { session } = await createAgentSessionFromServices({
      services,
      // In-memory: Crew (or the harness, per HARNESS_OWNED_SESSIONS) owns
      // transcripts; pi-side persistence would only strand resume state for
      // a session/load we do not advertise (initialize: loadSession false).
      sessionManager: SessionManager.inMemory(),
      model: resolveWantedModel(services.modelRuntime, process.env.PI_ACP_MODEL),
      customTools: customTools as any,
    });
    this.piSession = session;

    // Best-effort text streaming -> agent_message_chunk. Deltas stream live;
    // message_end full text is a fallback only when nothing streamed.
    const debugEvents = process.env.PI_ACP_DEBUG_EVENTS === "1";
    const seenTypes = new Map<string, number>();
    session.subscribe((event: any) => {
      if (debugEvents) {
        const t = `${event?.type ?? "?"}:${event?.message?.role ?? event?.assistantMessageEvent?.type ?? "-"}`;
        seenTypes.set(t, (seenTypes.get(t) ?? 0) + 1);
        const n = seenTypes.get(t) ?? 0;
        if (n <= 8) {
          console.error(`[pi-acp:evt] ${t} ${JSON.stringify(event).slice(0, 500)}`);
        }
      }
      // Compaction status, kiro-cli's `_kiro.dev/compaction/status` dialect.
      // pi reports BOTH manual (/compact) and automatic (threshold/overflow)
      // compactions as `compaction_start` / `compaction_end` on this same
      // subscription (synchronously emitted, `started` always first — before
      // auth, preparation, and summarization), so one handler covers both
      // paths. The terminal + fresh usage_update here are what Crew's
      // `compact()` drain captures mid-turn (manual) and what resets the
      // context meter (both, claude `compact_boundary` precedent).
      if (event?.type === "compaction_start") {
        this.compactionPending = true;
        this.cb.notifyCompaction("started", "");
        return;
      }
      if (event?.type === "compaction_end") {
        this.compactionPending = false;
        // The summarization call is not a session message, so its cost never
        // lands in message_end usage — fold it into the slice-6 cumulative
        // accumulator here so the meter's spend stays truthful.
        const summaryCost = event?.result?.usage?.cost?.total;
        if (typeof summaryCost === "number" && Number.isFinite(summaryCost)) {
          this.sessionCost += summaryCost;
        }
        const result = event?.result;
        // Aborted (including session/cancel mid-compact) reports `failed`:
        // kiro's status enum has no cancelled, and a terminal lets Crew's
        // wait_for_compaction settle instead of timing out.
        if (result && event?.aborted !== true) {
          this.cb.notifyCompaction(
            "completed",
            typeof result.summary === "string" ? result.summary : "",
          );
        } else {
          const reason =
            typeof event?.errorMessage === "string" && event.errorMessage
              ? event.errorMessage
              : event?.aborted === true
                ? "Compaction cancelled"
                : "Compaction failed";
          this.cb.notifyCompaction("failed", reason);
        }
        // Fresh meter reading: pi reports `tokens: null` (unknown until the
        // next assistant response) right after a compaction, and the adapter
        // reports `used: 0` so Crew's meter resets instead of holding the
        // stale pre-compaction fill. The next turn's usage_update corrects it.
        this.emitUsageUpdate(true);
        return;
      }
      const emit = (kind: "agent_message_chunk" | "agent_thought_chunk", text: string) => {
        if (!text) return;
        this.streamingText += text;
        this.cb.notifyUpdate({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: kind,
            // messageId is per-turn in ACP; reuse session-scoped rolling id.
            messageId: `msg_${this.sessionId}`,
            content: { type: "text", text },
          },
        });
      };
      const { text, thought } = extractStreamEvents(event);
      for (const d of text) emit("agent_message_chunk", d);
      for (const d of thought) emit("agent_thought_chunk", d);
      if (event?.type === "queue_update" && this.steerPending.length > 0) {
        // pi drains the steering queue into the running turn; when the array
        // empties, every pending steer was consumed (kiro's authoritative
        // steering_consumed signal -- the request response is fire-and-forget).
        if ((event.steering?.length ?? 1) === 0) {
          for (const text of this.steerPending) {
            this.cb.notifyUpdate({
              sessionId: this.sessionId,
              update: { sessionUpdate: "steering_consumed", content: text },
            });
          }
          this.steerPending = [];
        }
      }
      if (event?.type === "message_end" && event.message?.role === "assistant") {
        // Per-turn token counts + cumulative cost ride on pi's per-message
        // Usage; providers that report none leave both absent (the kiro path).
        const u = event.message.usage;
        if (u) {
          this.turnUsage = {
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheRead: u.cacheRead ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
          };
          const cost = u.cost?.total;
          if (typeof cost === "number" && Number.isFinite(cost)) {
            this.sessionCost += cost;
          }
        }
      }
      if (event?.type === "message_end" && this.streamingText === "") {
        emit("agent_message_chunk", extractFinalText(event));
      }
    });
  }

  async prompt(text: string): Promise<PromptResult> {
    this.cancelled = false;
    this.streamingText = "";
    this.turnUsage = null;
    await this.piSession.prompt(text);
    // An automatic mid-turn compaction that started but never delivered its
    // terminal settles here, before the trailing meter reading.
    this.settleCompaction();
    // One usage_update per turn, kiro-style (slice 6 contract, unchanged).
    this.emitUsageUpdate(false);
    return {
      stopReason: this.cancelled ? "cancelled" : "end_turn",
      streamedText: this.streamingText,
      turnUsage: this.turnUsage,
    };
  }

  /**
   * One flat `usage_update`, slice-6 shape (`used`/`size` from pi's own
   * `getContextUsage`, cumulative USD `cost` once a provider reported any).
   * Crew parses the FLAT shape (update.used/update.size) byte-identically
   * to kiro-cli's.
   *
   * `zeroWhenUnknown` selects the post-compaction reset semantic: right after
   * a compaction pi reports `tokens: null` (unknown until the next assistant
   * response), and the adapter reports `used: 0` so Crew's meter resets to
   * empty instead of holding the stale pre-compaction fill. A plain prompt
   * turn passes false and keeps slice 6's skip — an unknown reading there
   * (e.g. a cancelled turn) must not pose as empty.
   */
  private emitUsageUpdate(zeroWhenUnknown: boolean): void {
    const ctx = this.piSession?.getContextUsage?.();
    if (!ctx || !(ctx.contextWindow > 0)) return;
    const tokens: unknown = (ctx as { tokens?: unknown }).tokens;
    if (typeof tokens !== "number" && !zeroWhenUnknown) return;
    const update: Record<string, unknown> = {
      sessionUpdate: "usage_update",
      used: typeof tokens === "number" ? tokens : 0,
      size: ctx.contextWindow,
    };
    if (this.sessionCost > 0) {
      update.cost = { amount: this.sessionCost, currency: "USD" };
    }
    this.cb.notifyUpdate({ sessionId: this.sessionId, update });
  }

  /**
   * Close a `started`-without-terminal compaction at the turn's end.
   *
   * Mirrors Crew's `_settle_claude_compaction` (the claude adapter's automatic
   * compactions likewise report `started` and go quiet): only a turn that
   * reached its own natural terminal (`end_turn`) is evidence the compaction
   * finished, so only then is `completed` synthesized. A cancelled turn clears
   * the flag with no event and no counter reset — pressing Stop mid-compaction
   * must not fabricate success against a context that was never summarized.
   */
  private settleCompaction(): void {
    if (!this.compactionPending) return;
    this.compactionPending = false;
    if (this.cancelled) return;
    console.error("[pi-acp] compaction started without terminal; settling completed at turn end");
    this.cb.notifyCompaction("completed", "");
    this.emitUsageUpdate(true);
  }

  /**
   * Manual compaction for Crew's inline `/compact` (a `session/prompt` whose
   * text is `/compact [context]`). The `started`/terminal status frames and
   * the fresh `usage_update` are emitted by the `compaction_start` /
   * `compaction_end` subscription above — pi emits those for manual
   * compactions too, so the terminal strictly precedes this turn's response
   * and Crew's `compact()` drain captures it mid-turn. The turn still ACKs
   * `end_turn` on compaction failure (kiro-cli semantics: the failure rides
   * the `failed` status, and Crew's `wait_for_compaction()` settles on it).
   */
  async compact(customInstructions?: string): Promise<{ stopReason: string }> {
    this.cancelled = false;
    try {
      await this.piSession.compact(customInstructions);
    } catch {
      /* terminal `failed` already emitted by the subscription handler */
    }
    return { stopReason: this.cancelled ? "cancelled" : "end_turn" };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    try {
      await this.piSession.abort();
    } catch {
      /* ignore */
    }
  }

  /** Inject a mid-turn steer, kiro-cli's ``_session/steer`` dialect. */
  async steer(message: string): Promise<boolean> {
    const text = (message ?? "").trim();
    if (!text || !this.piSession || !this.piSession.isStreaming) return false;
    // Crew wraps the steer in <user_message> tags (kiro-cli dialect); the
    // wrapper is framing, not payload, and feeding it to the model verbatim
    // would leak the transport into the conversation. Strip exactly that
    // wrapper, nothing else.
    const unwrapped = text.replace(/^<user_message>\s*/, "").replace(/\s*<\/user_message>$/, "");
    this.steerPending.push(unwrapped);
    this.cb.notifyUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: "steering_queued", content: unwrapped },
    });
    try {
      await this.piSession.sendUserMessage(unwrapped, { deliverAs: "steer" });
      return true;
    } catch (err) {
      // The turn died between the isStreaming check and the injection; the
      // steer never reached the model, so say so and clear the ledger.
      this.steerPending = this.steerPending.filter((t) => t !== unwrapped);
      this.cb.notifyUpdate({
        sessionId: this.sessionId,
        update: { sessionUpdate: "steering_cleared" },
      });
      console.error(`pi-acp steer: injection failed, cleared: ${(err as Error).message}`);
      return false;
    }
  }

  async setModel(modelId: string): Promise<void> {
    // Live switch: pi swaps the model on the running session, history kept.
    // Unknown ids throw, and the caller (Crew) keeps serving the old model.
    if (!this.piSession || !this.modelRuntime) return;
    const model = resolveWantedModel(this.modelRuntime, modelId);
    if (!model) throw new Error(`unknown pi model ${modelId}`);
    await this.piSession.setModel(model);
  }

  async dispose(): Promise<void> {
    for (const conn of this.mcpConns) {
      await closeMcpConnection(conn);
    }
    this.mcpConns = [];
    this.bridgedByPiName.clear();
    this.gate.reset();
  }
}

function resultToText(result: any): string {
  try {
    if (typeof result === "string") return result;
    if (Array.isArray(result)) {
      return result
        .map((b) => (typeof b === "string" ? b : b?.text ?? JSON.stringify(b)))
        .join("\n");
    }
    if (result?.content && Array.isArray(result.content)) {
      return result.content
        .map((b: any) => (typeof b === "string" ? b : b?.text ?? JSON.stringify(b)))
        .join("\n");
    }
    return JSON.stringify(result);
  } catch {
    return "(unserializable result)";
  }
}

/** Resolve a `provider/id` or bare model id, or undefined for default. */
function resolveWantedModel(modelRuntime: any, wanted: string | undefined): any {
  if (!wanted) return undefined;
  const slash = wanted.indexOf("/");
  if (slash > 0) {
    const model = modelRuntime.getModel(wanted.slice(0, slash), wanted.slice(slash + 1));
    if (!model) throw new Error(`unknown pi model ${wanted}`);
    return model;
  }
  const found = (modelRuntime.getModels() as any[]).find((m: any) => m.id === wanted);
  if (!found) throw new Error(`unknown pi model ${wanted}`);
  return found;
}

function toTypeBox(schema: Record<string, any>): any {
  try {
    // MCP serves JSON Schema; pi tools want TypeBox. Unsafe passthrough
    // preserves validation semantics without lossy conversion.
    return (Type as any).Unsafe(schema ?? { type: "object" });
  } catch {
    return (Type as any).Object({});
  }
}
