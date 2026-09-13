/**
 * Slice 7 acceptance: kiro's `_session/steer` mid-turn extension.
 *   initialize -> session/new -> long session/prompt -> steer WHILE STREAMING
 *   -> expects {queued:true}, steering_queued + steering_consumed
 *   notifications with the unwrapped text, and the steered reply in the
 *   SAME in-flight turn's chunk stream.
 *
 * Skips (exit 0, "SKIP") on pi auth failure — CI without keys must not go red.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");

const skip = (why) => {
  console.log(`SKIP: ${why} (slice 1 is the keyless gate)`);
  process.exit(0);
};
const looksLikeAuthFailure = (msg) =>
  /api.?key|auth|sign.?in|credential|unauthorized|forbidden|401|403/i.test(String(msg ?? ""));

let nextId = 1;
const pending = new Map();
const updates = [];
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
      updates.push(msg);
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
    withTimeout(
      new Promise((resolve) => waiters.push({ pred, resolve })),
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

  // Long turn so the steer lands mid-flight: numbers stream for a while.
  const promptP = withTimeout(
    send(proc, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "List the numbers 1 through 20, one per line. Then reply DONE." }],
    }),
    180000,
    "session/prompt",
  );
  // Fire the steer as soon as the turn starts streaming.
  await withTimeout(waitFor((m) => m.method === "session/update" && (m.params?.update?.sessionUpdate === "agent_message_chunk"), 60000, "first chunk"), 20000, "chunk");
  const steered = "Reply with exactly NINE instead, then stop.";
  const steerRes = await withTimeout(
    send(proc, "_session/steer", { sessionId, message: `<user_message>\n${steered}\n</user_message>` }),
    30000,
    "_session/steer",
  );
  if (steerRes.error) fail(`_session/steer: ${steerRes.error.message}`);
  if (steerRes.result?.queued !== true) fail(`steer not queued: ${JSON.stringify(steerRes)}`);

  const promptRes = await promptP;
  if (promptRes.error) fail(`session/prompt: ${promptRes.error.message}`);
  if (promptRes.result?.stopReason !== "end_turn") fail(`stopReason = ${JSON.stringify(promptRes)}`);

  const queuedNotif = updates.find(
    (m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "steering_queued",
  );
  const consumedNotif = updates.find(
    (m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "steering_consumed",
  );
  if (!queuedNotif) fail("no steering_queued notification");
  if (!consumedNotif) fail("no steering_consumed notification");
  if (queuedNotif.params.update.content !== steered) {
    fail(`steering_queued content mismatch: ${JSON.stringify(queuedNotif.params.update)}`);
  }
  if (consumedNotif.params.update.content !== steered) {
    fail(`steering_consumed content mismatch: ${JSON.stringify(consumedNotif.params.update)}`);
  }
  console.log("ok: steering_queued + steering_consumed with unwrapped text");

  const stream = updates
    .filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk")
    .map((m) => m.params?.update?.content?.text ?? "")
    .join("");
  if (!/nine|9\b/i.test(stream)) fail(`steered reply not in stream: ${JSON.stringify(stream.slice(0, 300))}`);
  console.log("ok: steered reply streamed inside the SAME in-flight turn");

  console.log("\nSLICE 7 PASS");
  proc.kill();
  process.exit(0);
}

main();