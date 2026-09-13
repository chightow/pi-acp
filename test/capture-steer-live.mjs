/**
 * Slice 7 capture: records a steered pi-acp turn (agent->client lines only)
 * to test/steer-live.raw.jsonl, curatable into
 * test/fixtures/acp_frames/pi/steer.jsonl.
 *
 * Mirrors test/slice7-steer.mjs: long prompt, mid-turn `_session/steer`,
 * expects {queued:true} plus steering_queued/steering_consumed
 * notifications with the unwrapped text, reply in the same in-flight turn.
 *
 * Requires PI_ACP_MODEL with a streaming model. Auth failure -> SKIP.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");
const OUT = process.env.PI_ACP_CAPTURE_OUT ?? path.join(HERE, "steer-live.raw.jsonl");

const looksLikeAuthFailure = (msg) =>
  /api.?key|auth|sign.?in|credential|unauthorized|forbidden|401|403/i.test(String(msg ?? ""));
const skip = (why) => {
  console.log(`SKIP: ${why} (slice 1 is the keyless gate)`);
  process.exit(0);
};

let nextId = 1;
const pending = new Map();
const recorded = [];
const waiters = [];

function send(proc, method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
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
  const waitFor = (pred, ms, what) =>
    withTimeout(new Promise((resolve) => waiters.push({ pred, resolve })), ms, what);

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

  const promptP = withTimeout(
    send(proc, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "List the numbers 1 through 20, one per line. Then reply DONE." }],
    }),
    180000,
    "session/prompt",
  );
  await waitFor(
    (m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk",
    60000,
    "first chunk",
  );
  const steered = "Reply with exactly NINE instead, then stop.";
  const steerRes = await withTimeout(
    send(proc, "_session/steer", { sessionId, message: `<user_message>\n${steered}\n</user_message>` }),
    30000,
    "_session/steer",
  );
  if (steerRes.error || steerRes.result?.queued !== true) fail(`steer: ${JSON.stringify(steerRes)}`);
  const promptRes = await promptP;
  if (promptRes.error || promptRes.result?.stopReason !== "end_turn") {
    fail(`prompt: ${JSON.stringify(promptRes)}`);
  }

  const q = recorded.filter((l) => l.includes('"steering_queued"'));
  const c = recorded.filter((l) => l.includes('"steering_consumed"'));
  if (q.length !== 1 || c.length !== 1) fail(`notifications: queued=${q.length} consumed=${c.length}`);
  if (recorded.length > 50) fail(`too many frames to curate: ${recorded.length}`);

  fs.writeFileSync(OUT, recorded.join("\n") + "\n");
  console.log(`CAPTURED ${recorded.length} frames -> ${OUT}`);
  proc.kill();
  process.exit(0);
}

main();