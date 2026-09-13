/**
 * Slice 4 acceptance: Crew's `mcpServers[]` mounted as pi tools.
 *   session/new with a Crew-shaped stdio element (command/args/env array)
 *   -> prompt naming mcp__toy__echo_text -> permission asked for the
 *   bridged tool -> allow -> completed update carries toy output incl. env.
 *
 * Requires PI_ACP_MODEL with real tool calls (same note as slice 3).
 * Auth failure -> SKIP.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");
const TOY = path.join(HERE, "toy-mcp-server.mjs");

const looksLikeAuthFailure = (msg) =>
  /api.?key|auth|sign.?in|credential|unauthorized|forbidden|401|403/i.test(String(msg ?? ""));
const skip = (why) => {
  console.log(`SKIP: ${why} (slice 1 is the keyless gate)`);
  process.exit(0);
};

let nextId = 1;
const pending = new Map();
const updates = [];

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
      if (msg.method === "session/update") {
        updates.push(msg.params);
        continue;
      }
      if (msg.method === "session/request_permission" && msg.id !== undefined) {
        // Allow everything: this slice proves reachability, slice 3 proved gating.
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
  console.log("ok: session/new ->", sessionId);

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

  const bridgedCalls = updates.filter(
    (u) =>
      (u.update?.sessionUpdate === "tool_call" || u.update?.sessionUpdate === "tool_call_update") &&
      JSON.stringify(u).includes("mcp__toy__echo_text"),
  );
  if (bridgedCalls.length === 0) {
    fail("bridged tool never called — model skipped mcp__toy__echo_text (check PI_ACP_MODEL + promptSnippet)");
  }
  console.log("ok: bridged tool reached the gate");

  const completed = updates.find(
    (u) => u.update?.sessionUpdate === "tool_call_update" && u.update?.status === "completed",
  );
  const flat = JSON.stringify(completed ?? {});
  if (!flat.includes("toy-echo:slice4-mcp-ok")) fail(`toy output missing: ${flat.slice(0, 250)}`);
  if (!flat.includes("secret=slice4-env-ok")) fail(`env array did not reach server: ${flat.slice(0, 250)}`);
  console.log("ok: toy output + spawned env reached Crew frames");

  const chat = updates
    .filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
    .map((u) => u.update?.content?.text ?? "")
    .join("");
  if (!/MDONE/i.test(chat)) fail(`expected MDONE in chat: ${JSON.stringify(chat.slice(0, 200))}`);

  console.log("\nSLICE 4 PASS");
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
