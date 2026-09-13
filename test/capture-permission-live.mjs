/**
 * One-off capture for the Crew frame-replay corpus (slice 5b): drives pi-acp
 * through a bridged-tool turn exactly like the mcp-bridge test, but records every
 * agent->client line to test/fixtures/acp_frames/pi/permission-live.raw.jsonl.
 *
 * Requires PI_ACP_MODEL with real tool calls. Auth failure -> SKIP.
 * The raw file is CURATED (contiguous slice + _meta header + redaction) into
 * permission-live.jsonl before snapshotting; this script only records.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");
const TOY = path.join(HERE, "toy-mcp-server.mjs");
const OUT = process.env.PI_ACP_CAPTURE_OUT ??
  path.join(HERE, "permission-live.raw.jsonl");

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
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: "once" } } }) + "\n",
        );
        continue;
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

  await withTimeout(send(proc, "initialize", { protocolVersion: 1 }), 15000, "initialize");

  const created = await withTimeout(
    send(proc, "session/new", {
      cwd: process.cwd(),
      mcpServers: [
        {
          name: "toy",
          command: process.execPath,
          args: [TOY],
          env: [{ name: "TOY_SECRET", value: "slice4-env-ok" }],
        },
      ],
    }),
    60000,
    "session/new",
  );
  if (created.error) {
    if (looksLikeAuthFailure(created.error.message)) skip(`pi auth: ${created.error.message}`);
    fail(`session/new: ${created.error.message}`);
  }
  const sessionId = created.result?.sessionId;

  const res = await withTimeout(
    send(proc, "session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "You must call the tool named mcp__toy__echo_text with text set to slice4-mcp-ok, and nothing else. Afterwards reply with MDONE on its own line.",
        },
      ],
    }),
    180000,
    "session/prompt",
  );
  if (res.error) fail(`session/prompt: ${res.error.message}`);
  if (res.result?.stopReason !== "end_turn") fail(`stopReason = ${JSON.stringify(res)}`);

  fs.writeFileSync(OUT, recorded.join("\n") + "\n");
  console.log(`CAPTURED ${recorded.length} frames -> ${OUT}`);
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
