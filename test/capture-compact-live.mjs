/**
 * Slice 8 capture: records pi-acp's inline-/compact turns (agent->client
 * lines only) to test/compact-live.raw.jsonl, curatable into Crew's
 * test/fixtures/acp_frames/pi/compact.jsonl.
 *
 * Mirrors test/compact.mjs: tiny probe, bare /compact (failed: nothing
 * to compact), 3 bulk primers (>20k tokens), /compact with context
 * (completed + summary + meter reset), post-compact probe. Key frames are
 * asserted; the raw file is CURATED (contiguous slice + _meta header +
 * home->~ redaction) before snapshotting — this script only records.
 *
 * Requires PI_ACP_MODEL with a real model. Auth failure -> SKIP.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");
const OUT = process.env.PI_ACP_CAPTURE_OUT ?? path.join(HERE, "compact-live.raw.jsonl");

const METHOD_COMPACTION_STATUS = "_kiro.dev/compaction/status";

const looksLikeAuthFailure = (msg) =>
  /api.?key|auth|sign.?in|credential|unauthorized|forbidden|401|403/i.test(String(msg ?? ""));
const skip = (why) => {
  console.log(`SKIP: ${why} (slice 1 is the keyless gate)`);
  process.exit(0);
};

let nextId = 1;
const pending = new Map();
const recorded = [];

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
      recorded.push(line);
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
  const prompt = (sessionId, text, ms, what) =>
    withTimeout(
      send(proc, "session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
      ms,
      what,
    );

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

  const probe = await prompt(
    sessionId,
    "Reply with exactly the word PROBE and nothing else. Do not call any tools.",
    120000,
    "probe",
  );
  if (probe.error) {
    if (looksLikeAuthFailure(probe.error.message)) skip(`pi auth: ${probe.error.message}`);
    fail(`probe: ${probe.error.message}`);
  }

  const small = await prompt(sessionId, "/compact", 90000, "/compact (too small)");
  if (small.error || small.result?.stopReason !== "end_turn") fail(`/compact: ${JSON.stringify(small)}`);

  const filler = buildFiller(50 * 1024);
  for (let n = 1; n <= 3; n += 1) {
    const r = await prompt(
      sessionId,
      `Do not call any tools. Do not repeat, quote, or describe the filler block below. Reply with exactly the word PRIMED and nothing else.\n\n<filler block>\n${filler}`,
      240000,
      `bulk primer ${n}`,
    );
    if (r.error || r.result?.stopReason !== "end_turn") fail(`primer ${n}: ${JSON.stringify(r)}`);
  }

  const live = await prompt(sessionId, "/compact focus on API decisions", 300000, "/compact (live)");
  if (live.error || live.result?.stopReason !== "end_turn") fail(`/compact: ${JSON.stringify(live)}`);

  const post = await prompt(
    sessionId,
    "Reply with exactly the word COMPACTED and nothing else. Do not call any tools.",
    120000,
    "post-compact probe",
  );
  if (post.error || post.result?.stopReason !== "end_turn") fail(`post probe: ${JSON.stringify(post)}`);

  const types = recorded
    .filter((l) => l.includes(`"${METHOD_COMPACTION_STATUS}"`))
    .map((l) => JSON.parse(l).params?.status?.type);
  if (JSON.stringify(types) !== JSON.stringify(["started", "failed", "started", "completed"])) {
    fail(`compaction statuses: ${JSON.stringify(types)}`);
  }
  const usages = recorded.filter((l) => l.includes('"usage_update"'));
  if (usages.length < 6) fail(`want >= 6 usage_updates (probe+compact+3 primers+compact+probe), got ${usages.length}`);
  const lastUsed = JSON.parse(usages[usages.length - 2]).params?.update?.used;
  if (lastUsed !== 0) fail(`post-compact usage_update.used = ${lastUsed} (want 0)`);

  fs.writeFileSync(OUT, recorded.join("\n") + "\n");
  console.log(`CAPTURED ${recorded.length} frames -> ${OUT}`);
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
