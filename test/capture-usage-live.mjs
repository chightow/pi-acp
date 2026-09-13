/**
 * Slice 6 capture: records a two-turn pi-acp session to
 * test/usage-live.raw.jsonl (agent->client lines only), curatable into
 * test/fixtures/acp_frames/pi/usage.jsonl.
 *
 * Two plain prompts, no MCP servers: each turn must emit one usage_update
 * (flat used/size from pi's getContextUsage, cumulative USD cost once the
 * provider reports any) and the second prompt's response must carry
 * turn-scoped token counts when the provider reports usage.
 *
 * Requires PI_ACP_MODEL with provider-reported usage. Auth failure -> SKIP.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");
const OUT =
  process.env.PI_ACP_CAPTURE_OUT ?? path.join(HERE, "usage-live.raw.jsonl");

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

  const turns = [
    "Reply with exactly the word USAGEONE and nothing else.",
    "Reply with exactly the word USAGETWO and nothing else.",
  ];
  for (const turn of turns) {
    const res = await withTimeout(
      send(proc, "session/prompt", { sessionId, prompt: [{ type: "text", text: turn }] }),
      180000,
      "session/prompt",
    );
    if (res.error) fail(`session/prompt: ${res.error.message}`);
    if (res.result?.stopReason !== "end_turn") fail(`stopReason = ${JSON.stringify(res)}`);
  }

  const usageFrames = recorded.filter((l) => l.includes('"usage_update"'));
  if (usageFrames.length !== 2) fail(`expected 2 usage_update frames, got ${usageFrames.length}`);
  const first = JSON.parse(usageFrames[0]).params.update;
  if (!(Number.isFinite(first.used) && first.used > 0 && first.size > 0 && first.used <= first.size)) {
    fail(`first usage_update invalid: ${JSON.stringify(first)}`);
  }

  fs.writeFileSync(OUT, recorded.join("\n") + "\n");
  console.log(`CAPTURED ${recorded.length} frames (${usageFrames.length} usage_update) -> ${OUT}`);
  proc.kill();
  process.exit(0);
}

main();