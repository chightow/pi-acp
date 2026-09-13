/**
 * SLICE 3 — permission bridge. Every pi tool call blocks on KiroCrew's
 * `session/request_permission`; Crew's verdict gates execution.
 *
 * Wire facts this implements:
 * - Full duplex over one stdio pipe: incoming client requests (handled
 *   CONCURRENTLY — never `await` the read loop, or a prompt turn would
 *   deadlock the permission answer riding the same stdin), outgoing agent
 *   requests with `out-N` string ids (no collision with Crew's numerics),
 *   interleaved `session/update` notifications.
 * - `session/cancel` also fail-safes pending permission asks for that
 *   session to reject, so an aborted turn can settle instead of hanging.
 * - Verdict parsing fail-safes to reject (see acp.permissionVerdict).
 *
 * Slice 4 passes session/new mcpServers through to the pi session.
 */
import {
  METHOD_INITIALIZE,
  METHOD_SESSION_NEW,
  METHOD_SESSION_LOAD,
  METHOD_SESSION_PROMPT,
  METHOD_SESSION_CANCEL,
  METHOD_SET_CONFIG_OPTION,
  METHOD_REQUEST_PERMISSION,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  buildInitializeResult,
  buildSessionNewResult,
  buildConfigOptions,
  buildConfigOptionUpdate,
  isValidEffort,
  promptBlocksToText,
  agentMessageChunk,
  nextMessageId,
  permissionOptions,
  permissionVerdict,
} from "./acp.js";
import {
  PiSession,
  adapterMaxSessionSeq,
  findAdapterSessionFile,
  normalizeCwdForCompare,
} from "./pi-session.js";

// kiro-cli's mid-turn steer extension (Crew's `_session/steer`). Fire-and-
// forget on Crew's side: the request response is a formality, and the
// authoritative signal is the `steering_queued` / `steering_consumed`
// notifications pi-session.ts rides on session/update.
const METHOD_SESSION_STEER = "_session/steer";

// kiro-cli's compaction-status method (Crew's `compact()` / wait_for_compaction
// watch this on the prompt stream). Rides its own method, NOT session/update.
const METHOD_COMPACTION_STATUS = "_kiro.dev/compaction/status";

interface SessionRecord {
  pi: PiSession;
  model: string;
  mode: string;
  /** Last applied effort level (pi thinkingLevel). Mirrors pi.effort(). */
  effort: string;
  /** Serializes prompts: Crew waits for stopReason, but never pipeline. */
  queue: Promise<void>;
}

// Keyless wire-test escape hatch: with PI_ACP_ECHO=1, session/new + prompt
// use in-memory echo (slice 1 behavior) and never boot pi.
const ECHO_MODE = process.env.PI_ACP_ECHO === "1";
interface EchoSession {
  echo: true;
  id: string;
  cwd: string;
  model: string;
  mode: string;
  effort: string;
}
const sessions = new Map<string, SessionRecord | EchoSession>();
/**
 * Slice 10: start above the highest stored `ses_pi_N` so a restart never
 * reissues an id that has a transcript on disk (which would fork two
 * histories under one id and corrupt resume). Derived from the store at
 * startup (self-healing — no counter file to corrupt); the new-path loop
 * below additionally skips any id that gained a file after startup.
 */
let sessionSeq = 0;
try {
  if (!ECHO_MODE) sessionSeq = adapterMaxSessionSeq();
} catch {
  sessionSeq = 0;
}
const isEcho = (s: SessionRecord | EchoSession): s is EchoSession =>
  (s as EchoSession).echo === true;

/** Shared session callbacks so `session/new` and `session/load` boot identically. */
function makeSessionCallbacks(sessionId: string) {
  return {
    notifyUpdate: notify,
    notifyCompaction: (type: "started" | "completed" | "failed", summary: string) => {
      // kiro-cli's method shape: the status type rides params.status,
      // human text rides top-level params.summary; failure detail
      // additionally rides params.reason, the rank-2 key Crew's
      // compaction_failure_detail walker reads.
      const params: Record<string, unknown> = { status: { type } };
      if (summary) {
        params.summary = summary;
        if (type === "failed") params.reason = summary;
      }
      send({ jsonrpc: "2.0", method: METHOD_COMPACTION_STATUS, params });
    },
    requestPermission: (p: {
      toolCallId: string;
      title: string;
      kind: string;
      rawInput: Record<string, any>;
    }) => askCrew(sessionId, p),
  };
}

/**
 * Slice 10: mint a fresh `ses_pi_N` that has no stored transcript.
 * The startup scan usually suffices; this loop covers a file that landed
 * after startup (e.g. a concurrent adapter process).
 */
function mintFreshSessionId(): string {
  for (;;) {
    sessionSeq += 1;
    const candidate = `ses_pi_${sessionSeq}`;
    try {
      if (!findAdapterSessionFile(candidate)) return candidate;
    } catch {
      return candidate;
    }
    // Collision with a stored transcript: skip it (never reuse).
  }
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notify(update: unknown): void {
  send({ jsonrpc: "2.0", method: "session/update", params: update });
}

// ── Outgoing agent->client requests ───────────────────────────────

let outSeq = 0;
const pendingOutgoing = new Map<
  string,
  { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();
/** Permission asks outlive slow operators; 30 min ceiling then fail-safe. */
const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;

function mintOutgoingId(): string {
  outSeq += 1;
  return `out-${outSeq}`;
}

function sendAgentRequestWithId(id: string, method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingOutgoing.delete(id);
      reject(new Error(`${method} timed out`));
    }, PERMISSION_TIMEOUT_MS);
    pendingOutgoing.set(id, { resolve, reject, timer });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function sendAgentRequest(method: string, params: unknown): Promise<any> {
  return sendAgentRequestWithId(mintOutgoingId(), method, params);
}

function settleOutgoing(msg: any): boolean {
  if (msg.method !== undefined || msg.id === undefined) return false;
  const pend = pendingOutgoing.get(String(msg.id));
  if (!pend) return false;
  pendingOutgoing.delete(String(msg.id));
  clearTimeout(pend.timer);
  if (msg.error) pend.reject(new Error(msg.error.message ?? "request failed"));
  else pend.resolve(msg.result);
  return true;
}

/** Rejections waiting on a session (fail-safe deny on cancel). */
const pendingBySession = new Map<string, Set<string>>();
function trackPermission(sessionId: string, reqId: string): void {
  let set = pendingBySession.get(sessionId);
  if (!set) {
    set = new Set();
    pendingBySession.set(sessionId, set);
  }
  set.add(reqId);
}
function untrackPermission(sessionId: string, reqId: string): void {
  pendingBySession.get(sessionId)?.delete(reqId);
}
function denyPendingForSession(sessionId: string): void {
  const set = pendingBySession.get(sessionId);
  if (!set) return;
  for (const reqId of set) {
    const pend = pendingOutgoing.get(reqId);
    if (pend) {
      pendingOutgoing.delete(reqId);
      clearTimeout(pend.timer);
      pend.reject(new Error("session cancelled"));
    }
  }
  set.clear();
}

async function askCrew(
  sessionId: string,
  tool: { toolCallId: string; title: string; kind: string; rawInput: Record<string, any> },
): Promise<"once" | "always" | "reject"> {
  const reqId = mintOutgoingId();
  trackPermission(sessionId, reqId);
  try {
    const result = await sendAgentRequestWithId(reqId, METHOD_REQUEST_PERMISSION, {
      sessionId,
      toolCall: {
        toolCallId: tool.toolCallId,
        title: tool.title,
        kind: tool.kind,
        status: "pending",
        rawInput: tool.rawInput,
      },
      options: permissionOptions(),
    });
    return permissionVerdict(result);
  } catch (err) {
    console.error(`[pi-acp] permission ask failed fail-safe: ${(err as Error).message}`);
    return "reject";
  } finally {
    untrackPermission(sessionId, reqId);
  }
}

// ── Incoming client->agent requests ───────────────────────────────

async function handleRequest(id: number | string, method: string, params: any): Promise<void> {
  switch (method) {
    case METHOD_INITIALIZE: {
      send({ jsonrpc: "2.0", id, result: buildInitializeResult() });
      return;
    }
    case METHOD_SESSION_NEW: {
      const cwd = typeof params?.cwd === "string" ? params.cwd : process.cwd();
      if (ECHO_MODE) {
        sessionSeq += 1;
        const sessionId = `ses_pi_slice1_${sessionSeq}`;
        sessions.set(sessionId, { echo: true, id: sessionId, cwd, model: "pi-default", mode: "read-only", effort: "medium" });
        send({ jsonrpc: "2.0", id, result: buildSessionNewResult(sessionId, "pi-default", "medium") });
        return;
      }
      const sessionId = mintFreshSessionId();
      const pi = new PiSession(sessionId, cwd, makeSessionCallbacks(sessionId));
      try {
        const mcpServers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
        await pi.start(mcpServers);
      } catch (err) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: INVALID_PARAMS, message: `pi session failed: ${(err as Error).message}` },
        });
        return;
      }
      sessions.set(sessionId, { pi, model: pi.modelId(), mode: "read-only", effort: pi.effort(), queue: Promise.resolve() });
      send({ jsonrpc: "2.0", id, result: buildSessionNewResult(sessionId, pi.modelId(), pi.effort(), pi.availableModels()) });
      return;
    }
    case METHOD_SESSION_LOAD: {
      // Slice 10 — ACP resume. Same envelope as session/new (sessionId +
      // configOptions incl. current model/mode/effort; NO modes block — the
      // LOAD_WITHOUT_MODES precedent). Unknown ids ERROR so Crew falls back
      // to session/new. cwd mismatches fail closed like slice 9's unknown
      // values. MCP re-declared on the load params reconnects BEFORE the
      // resume so the session keeps its tools.
      const sessionId = params?.sessionId;
      if (typeof sessionId !== "string" || !sessionId) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: INVALID_PARAMS, message: `unknown session ${String(sessionId)}` },
        });
        return;
      }
      const cwd = typeof params?.cwd === "string" ? params.cwd : process.cwd();
      if (ECHO_MODE) {
        const rec = sessions.get(sessionId);
        if (rec && isEcho(rec)) {
          send({ jsonrpc: "2.0", id, result: buildSessionNewResult(rec.id, rec.model, rec.effort) });
        } else {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: INVALID_PARAMS, message: `unknown session ${sessionId}` },
          });
        }
        return;
      }
      // Live in this process already (e.g. double-load): re-declare nothing,
      // just re-report the envelope. cwd still enforced fail-closed.
      const live = sessions.get(sessionId);
      if (live && !isEcho(live)) {
        if (normalizeCwdForCompare(live.pi.cwd) !== normalizeCwdForCompare(cwd)) {
          send({
            jsonrpc: "2.0",
            id,
            error: {
              code: INVALID_PARAMS,
              message: `session cwd mismatch: stored ${live.pi.cwd} vs requested ${cwd}`,
            },
          });
          return;
        }
        send({
          jsonrpc: "2.0",
          id,
          result: buildSessionNewResult(sessionId, live.pi.modelId(), live.pi.effort(), live.pi.availableModels()),
        });
        return;
      }
      if (live && isEcho(live)) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: INVALID_PARAMS, message: `unknown session ${sessionId}` },
        });
        return;
      }
      const pi = new PiSession(sessionId, cwd, makeSessionCallbacks(sessionId));
      try {
        const mcpServers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
        await pi.resume(mcpServers);
      } catch (err) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: INVALID_PARAMS, message: (err as Error).message },
        });
        return;
      }
      sessions.set(sessionId, { pi, model: pi.modelId(), mode: "read-only", effort: pi.effort(), queue: Promise.resolve() });
      send({ jsonrpc: "2.0", id, result: buildSessionNewResult(sessionId, pi.modelId(), pi.effort(), pi.availableModels()) });
      return;
    }
    case METHOD_SESSION_PROMPT: {
      const sessionId = params?.sessionId;
      const rec = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!rec) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: INVALID_PARAMS, message: `unknown session ${String(sessionId)}` },
        });
        return;
      }
      const text = promptBlocksToText(params?.prompt ?? "");
      if (isEcho(rec)) {
        const messageId = nextMessageId();
        send({ jsonrpc: "2.0", method: "session/update", params: agentMessageChunk(rec.id, messageId, `pi-acp slice1 echo: ${text}`) });
        send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        return;
      }
      // Slice 8: Crew's inline `/compact` — compaction requested as
      // `session/prompt` text (`/compact` + optional trailing context as the
      // summarizer's custom instructions), NOT via commands/execute. Runs
      // pi.compact() instead of pi.prompt(); the `started`/terminal status
      // notifications + fresh usage_update are emitted mid-turn by
      // pi-session (synchronously, before this turn's response), so Crew's
      // compact() drain captures the terminal and wait_for_compaction()
      // settles on it. Echo sessions keep frozen slice-1 behavior above.
      if (/^\/compact(?=\s|$)/.exec(text)) {
        const customInstructions = text.slice("/compact".length).trim() || undefined;
        const compactRun = rec.queue.then(async () => {
          try {
            const { stopReason } = await rec.pi.compact(customInstructions);
            send({ jsonrpc: "2.0", id, result: { stopReason } });
          } catch (err) {
            send({
              jsonrpc: "2.0",
              id,
              error: { code: INVALID_PARAMS, message: `pi compact failed: ${(err as Error).message}` },
            });
          }
        });
        // Keep the chain alive for the next prompt even if this one throws.
        rec.queue = compactRun.catch(() => {});
        await compactRun;
        return;
      }
      const run = rec.queue.then(async () => {
        try {
          const { stopReason, turnUsage } = await rec.pi.prompt(text);
          const result: Record<string, unknown> = { stopReason };
          // Turn-scoped token counts, only when the provider reported usage
          // (kiro-cli omits them, and Crew's parse_usage_prompt_turn reads
          // the flat keys in preference to the nested usage object).
          if (turnUsage) {
            result.inputTokens = turnUsage.input;
            result.outputTokens = turnUsage.output;
            result.cachedReadTokens = turnUsage.cacheRead;
            result.cachedWriteTokens = turnUsage.cacheWrite;
          }
          send({ jsonrpc: "2.0", id, result });
        } catch (err) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: INVALID_PARAMS, message: `pi prompt failed: ${(err as Error).message}` },
          });
        }
      });
      // Keep the chain alive for the next prompt even if this one throws.
      rec.queue = run.catch(() => {});
      await run;
      return;
    }
    case METHOD_SESSION_CANCEL: {
      const sid = typeof params?.sessionId === "string" ? params.sessionId : undefined;
      const rec = sid ? sessions.get(sid) : undefined;
      if (rec && !isEcho(rec)) {
        denyPendingForSession(sid!);
        await rec.pi.cancel().catch(() => {});
      }
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    case METHOD_SESSION_STEER: {
      const rec = typeof params?.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
      if (!rec || isEcho(rec)) {
        send({ jsonrpc: "2.0", id, result: { queued: false } });
        return;
      }
      const message = typeof params?.message === "string" ? params.message : "";
      const queued = await rec.pi.steer(message);
      // Crew never awaits this response (its read loop is busy with the turn),
      // but the honest answer still costs nothing -- and an idle-session steer
      // keeps the payload shape for the reader that pops it.
      send({ jsonrpc: "2.0", id, result: { queued } });
      return;
    }
    case METHOD_SET_CONFIG_OPTION: {
      const rec = typeof params?.sessionId === "string" ? sessions.get(params.sessionId) : undefined;
      if (rec) {
        const sid = params.sessionId as string;
        if (params?.configId === "model" && typeof params?.value === "string") {
          // Fail-closed (slice-5 precedent): unknown model ids throw and Crew
          // keeps serving the old model — no silent downgrade. On success the
          // thinking level may have reset for the new model, so the
          // follow-up config_option_update carries the rebuilt effort options
          // (full-array replace Crew's _handle_config_option_update consumes).
          if (isEcho(rec)) {
            rec.model = params.value;
            notify(buildConfigOptionUpdate(sid, buildConfigOptions(rec.model, rec.mode, rec.effort)));
          } else {
            try {
              await rec.pi.setModel(params.value);
            } catch (err) {
              send({
                jsonrpc: "2.0",
                id,
                error: { code: INVALID_PARAMS, message: `Invalid value for config option model: ${params.value} (${(err as Error).message})` },
              });
              return;
            }
            rec.model = rec.pi.modelId();
            rec.effort = rec.pi.effort();
            notify(buildConfigOptionUpdate(sid, buildConfigOptions(rec.model, rec.mode, rec.effort, rec.pi.availableModels())));
          }
        } else if (params?.configId === "effort") {
          // Slice 9 — effort knob → pi thinking level. Unknown values throw
          // (fail-closed, old level keeps serving); message mirrors
          // claude-agent-acp so Crew's step-down ladder recognizes it.
          const value = params?.value;
          if (!isValidEffort(value)) {
            send({
              jsonrpc: "2.0",
              id,
              error: { code: INVALID_PARAMS, message: `Invalid value for config option effort: ${String(value)}` },
            });
            return;
          }
          if (isEcho(rec)) {
            rec.effort = value;
            notify(buildConfigOptionUpdate(sid, buildConfigOptions(rec.model, rec.mode, rec.effort)));
          } else {
            let actual: string;
            try {
              actual = rec.pi.setEffort(value);
            } catch (err) {
              send({
                jsonrpc: "2.0",
                id,
                error: { code: INVALID_PARAMS, message: (err as Error).message },
              });
              return;
            }
            rec.effort = actual;
            notify(buildConfigOptionUpdate(sid, buildConfigOptions(rec.model, rec.mode, actual, rec.pi.availableModels())));
          }
        } else if (params?.configId === "mode" && typeof params?.value === "string") {
          rec.mode = params.value;
        } else {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: INVALID_PARAMS, message: `Unknown config option: ${String(params?.configId)}` },
          });
          return;
        }
      }
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    default: {
      send({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `unknown method ${method}` } });
      return;
    }
  }
}

async function main(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buf = "";
  for await (const chunk of process.stdin) {
    buf += chunk;
    // Split on \n ONLY (never generic line readers — U+2028/29 are valid in JSON).
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // malformed frame: ignore, never crash the pipe
      }
      if (msg && typeof msg.method === "string" && msg.id !== undefined) {
        // Concurrent: a prompt turn must NOT block permission answers
        // arriving on the same stdin.
        void handleRequest(msg.id, msg.method, msg.params).catch((err) =>
          console.error(`[pi-acp] request failed: ${(err as Error).message}`),
        );
      } else if (msg && msg.id !== undefined) {
        settleOutgoing(msg);
      }
      // Client notifications (method, no id): nothing to handle yet.
    }
  }
}

main()
  .then(() => process.exit(0)) // client hung up: no sessions can survive it
  .catch((err) => {
    console.error(`[pi-acp] fatal: ${(err as Error).message}`);
    process.exit(1);
  });
