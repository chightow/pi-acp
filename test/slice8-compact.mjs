/**
 * Slice 8 acceptance: kiro's inline `/compact` parity.
 *   initialize -> session/new -> tiny probe -> bare `/compact` (too small:
 *   `failed`) -> 3 bulk primers (>20k tokens) -> `/compact <context>`
 *   (`completed`) -> post-compact probe (meter alive again).
 *
 * Asserts per /compact turn: `end_turn` ACK, `started` then terminal
 * `_kiro.dev/compaction/status` strictly BEFORE the prompt response (so
 * Crew's compact() drain captures the terminal mid-turn), exactly one fresh
 * flat `usage_update` after the terminal, and the meter reset
 * (post-compact used === 0 < pre-compact used).
 *
 * Skips (exit 0, "SKIP") on pi auth failure — CI without keys must not go red.
 *
 * Requires PI_ACP_MODEL naming a real model for the live path
 * (e.g. opencode-go/muse-spark-1.3-contributor); the failure path needs no
 * summarization but the probe turn still needs a model that answers.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");

const METHOD_COMPACTION_STATUS = "_kiro.dev/compaction/status";

const skip = (why) => {
  console.log(`SKIP: ${why} (slice 1 is the keyless gate)`);
  process.exit(0);
};
const looksLikeAuthFailure = (msg) =>
  /api.?key|auth|sign.?in|credential|unauthorized|forbidden|401|403/i.test(String(msg ?? ""));

let nextId = 1;
const pending = new Map();
/** Every agent->client frame in arrival order (notifications AND responses). */
const frames = [];
const waiters = [];

function send(proc, method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function buildFiller(bytes) {
  const lines = [];
  let len = 0;
  let i = 0;
  while (len < bytes) {
    const line = `filler line ${String(i).padStart(5, "0")} the quick brown fox jumps over the lazy dog 0123456789\n`;
    lines.push(line);
    len += line.length;
    i += 1;
  }
  return lines.join("");
}

async function main() {
  const proc = spawn(process.execPath, [ADAPTER], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      frames.push(msg);
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id).resolve(msg);
        pending.delete(msg.id);
      }
    }
  });

  const fail = (m) => {
    console.error(`FAIL: ${m}`);
    proc.kill();
    process.exit(1);
  };
  const withTimeout = (p, ms, what) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms)),
    ]);

  const statusType = (m) => m?.params?.status?.type;
  const isCompaction = (m) => m.method === METHOD_COMPACTION_STATUS;
  const isUsage = (m) =>
    m.method === "session/update" && m.params?.update?.sessionUpdate === "usage_update";

  /** Send a session/prompt; resolve with the response + frames it produced. */
  const doPrompt = async (sessionId, text, ms, what) => {
    const from = frames.length;
    const res = await withTimeout(
      send(proc, "session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
      ms,
      what,
    );
    return { res, produced: frames.slice(from) };
  };
  const checkUsageShape = (u, where) => {
    const { used, size } = u;
    if (!Number.isFinite(used) || used < 0) fail(`${where}: usage_update.used invalid: ${JSON.stringify(u)}`);
    if (!Number.isFinite(size) || size <= 0) fail(`${where}: usage_update.size invalid: ${JSON.stringify(u)}`);
    if (used > size) fail(`${where}: usage_update.used ${used} > size ${size}`);
  };

  await withTimeout(send(proc, "initialize", { protocolVersion: 1 }), 15000, "initialize");

  const created = await withTimeout(
    send(proc, "session/new", { cwd: process.cwd(), mcpServers: [] }),
    60000,
    "session/new",
  );
  if (created.error) {
    if (looksLikeAuthFailure(created.error.message)) skip(`pi auth: ${created.error.message}`);
    fail(`session/new: ${created.error.message}`);
  }
  const sessionId = created.result?.sessionId;
  if (!sessionId) fail("no sessionId");
  console.log(`ok: session/new -> ${sessionId}`);

  // Probe: proves auth works (else SKIP like slices 2/7) and leaves one tiny
  // turn — far too small to compact, so the bare /compact below must fail.
  const probe = await doPrompt(
    sessionId,
    "Reply with exactly the word PROBE and nothing else. Do not call any tools.",
    120000,
    "probe prompt",
  );
  if (probe.res.error) {
    if (looksLikeAuthFailure(probe.res.error.message)) skip(`pi auth: ${probe.res.error.message}`);
    fail(`probe prompt: ${probe.res.error.message}`);
  }
  if (probe.res.result?.stopReason !== "end_turn") fail(`probe stopReason = ${JSON.stringify(probe.res)}`);
  console.log("ok: probe turn answers (auth works)");

  // Path 1: bare /compact on a ~100-token session. pi has nothing to
  // summarize, so the terminal must be `failed` — still preceded by `started`,
  // still ACKed end_turn, still followed by a fresh usage_update.
  {
    const { res, produced } = await doPrompt(sessionId, "/compact", 90000, "/compact (too small)");
    if (res.error) fail(`/compact response: ${res.error.message}`);
    if (res.result?.stopReason !== "end_turn") fail(`/compact stopReason = ${JSON.stringify(res)}`);
    for (const k of ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens"]) {
      if (res.result?.[k] !== undefined) fail(`/compact carried turn usage ${k} (no prompt ran): ${JSON.stringify(res.result)}`);
    }
    const statuses = produced.filter(isCompaction);
    const types = statuses.map(statusType);
    if (JSON.stringify(types) !== JSON.stringify(["started", "failed"])) {
      fail(`/compact statuses = ${JSON.stringify(types)} (want ["started","failed"])`);
    }
    const reason = statuses[1].params?.summary ?? statuses[1].params?.reason ?? "";
    if (!reason || !/nothing to compact/i.test(String(reason))) {
      fail(`/compact failure reason unexpected: ${JSON.stringify(statuses[1].params)}`);
    }
    console.log(`ok: bare /compact -> started + failed (${JSON.stringify(String(reason).slice(0, 80))})`);
    const idx = (m) => frames.indexOf(m);
    if (!(idx(statuses[0]) < idx(statuses[1]) && idx(statuses[1]) < idx(res))) {
      fail("bare /compact: terminal did not arrive mid-turn (before the response)");
    }
    const usages = produced.filter(isUsage);
    if (usages.length !== 1) fail(`bare /compact: want exactly 1 usage_update, got ${usages.length}`);
    if (!(idx(statuses[1]) < idx(usages[0]))) fail("bare /compact: usage_update not after the terminal");
    checkUsageShape(usages[0].params.update, "bare /compact");
    console.log(
      `ok: bare /compact usage_update used=${usages[0].params.update.used} size=${usages[0].params.update.size}`,
    );
  }

  // Build compactable context: 3 x 50KB filler turns. pi's keep window is
  // 20k tokens, so the newest ~2 turns (~25k tokens) stay recent and the
  // oldest turn is left over to summarize.
  const filler = buildFiller(50 * 1024);
  let usageBefore = 0;
  let windowSize = 0;
  for (let n = 1; n <= 3; n += 1) {
    const { res, produced } = await doPrompt(
      sessionId,
      `Do not call any tools. Do not repeat, quote, or describe the filler block below. Reply with exactly the word PRIMED and nothing else.\n\n<filler block>\n${filler}`,
      240000,
      `bulk primer ${n}`,
    );
    if (res.error) fail(`bulk primer ${n}: ${res.error.message}`);
    if (res.result?.stopReason !== "end_turn") fail(`bulk primer ${n} stopReason = ${JSON.stringify(res)}`);
    const usages = produced.filter(isUsage);
    if (usages.length !== 1) fail(`bulk primer ${n}: want exactly 1 usage_update, got ${usages.length}`);
    const u = usages[0].params.update;
    checkUsageShape(u, `bulk primer ${n}`);
    usageBefore = u.used;
    windowSize = u.size;
    console.log(`ok: bulk primer ${n}/3 used=${u.used} size=${u.size}`);
  }
  if (!(usageBefore > 20000)) {
    fail(`bulk primers built only ${usageBefore} tokens (need > 20000 to compact)`);
  }

  // Path 2: /compact with trailing context (the summarizer's custom
  // instructions). Must complete, forward pi's summary, and reset the meter.
  let summarySeen = "";
  {
    const { res, produced } = await doPrompt(
      sessionId,
      "/compact focus on API decisions",
      300000,
      "/compact (live)",
    );
    if (res.error) fail(`/compact response: ${res.error.message}`);
    if (res.result?.stopReason !== "end_turn") fail(`/compact stopReason = ${JSON.stringify(res)}`);
    const statuses = produced.filter(isCompaction);
    const types = statuses.map(statusType);
    if (JSON.stringify(types) !== JSON.stringify(["started", "completed"])) {
      const detail = statuses.map((m) => JSON.stringify(m.params)).join(" | ");
      fail(`/compact statuses = ${JSON.stringify(types)} (want ["started","completed"]; ${detail})`);
    }
    summarySeen = String(statuses[1].params?.summary ?? "");
    if (!summarySeen.trim()) fail("/compact completed with an empty summary");
    console.log(`ok: /compact -> started + completed (summary ${summarySeen.length} chars)`);
    const idx = (m) => frames.indexOf(m);
    if (!(idx(statuses[0]) < idx(statuses[1]) && idx(statuses[1]) < idx(res))) {
      fail("/compact: terminal did not arrive mid-turn (before the response)");
    }
    const usages = produced.filter(isUsage);
    if (usages.length !== 1) fail(`/compact: want exactly 1 usage_update, got ${usages.length}`);
    if (!(idx(statuses[1]) < idx(usages[0]))) fail("/compact: usage_update not after the terminal");
    const u = usages[0].params.update;
    checkUsageShape(u, "/compact");
    if (u.used !== 0) fail(`/compact meter did not reset: used=${u.used} (want 0)`);
    if (u.size !== windowSize) fail(`/compact window moved: size=${u.size} (want ${windowSize})`);
    console.log(`ok: meter reset used=${usageBefore} -> ${u.used} (size ${u.size})`);
  }

  // The meter must come back alive on the next turn, still compacted-small.
  {
    const { res, produced } = await doPrompt(
      sessionId,
      "Reply with exactly the word COMPACTED and nothing else. Do not call any tools.",
      120000,
      "post-compact probe",
    );
    if (res.error) fail(`post-compact probe: ${res.error.message}`);
    if (res.result?.stopReason !== "end_turn") fail(`post-compact stopReason = ${JSON.stringify(res)}`);
    const usages = produced.filter(isUsage);
    if (usages.length !== 1) fail(`post-compact probe: want exactly 1 usage_update, got ${usages.length}`);
    const u = usages[0].params.update;
    checkUsageShape(u, "post-compact probe");
    if (!(u.used > 0 && u.used < usageBefore)) {
      fail(`post-compact meter wrong: used=${u.used} (want 0 < used < ${usageBefore})`);
    }
    console.log(`ok: post-compact meter alive again used=${u.used}`);
  }

  console.log("\nSLICE 8 PASS");
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
