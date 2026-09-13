/**
 * Slice 3 acceptance: the permission bridge end-to-end.
 *   initialize -> session/new -> prompt ("use bash to run echo ...")
 *   -> adapter emits tool_call frames + session/request_permission
 *   -> test answers like KiroCrew would (spec-shaped outcome object)
 *   -> turn completes; then a second prompt answered with deny.
 *
 * Asserts: request params carry toolCallId/title/kind/rawInput + the
 * once/always/reject options; allow runs the command (output in the
 * completed update); deny blocks fail-safe (failed update, turn still ends).
 * Auth failure -> SKIP (slice 1 is the keyless gate).
 *
 * Requires PI_ACP_MODEL to name a tool-capable model
 * (e.g. opencode-go/muse-spark-1.3-contributor): the default flash model
 * hallucinates tool calls instead of emitting them, which fails honestly
 * at the "ran no tool" assertion.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");

const looksLikeAuthFailure = (msg) =>
  /api.?key|auth|sign.?in|credential|unauthorized|forbidden|401|403/i.test(String(msg ?? ""));
const skip = (why) => {
  console.log(`SKIP: ${why} (slice 1 is the keyless gate)`);
  process.exit(0);
};

let nextId = 1;
const pending = new Map();
const updates = [];
const permRequests = [];

function send(proc, method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function respond(proc, id, result) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

async function main() {
  const proc = spawn(process.execPath, [ADAPTER], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  proc.stdout.setEncoding("utf8");

  // Permission policy delegate: set per prompt phase by the driver below.
  let policy = null;
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
        permRequests.push(msg.params);
        if (policy) policy(msg);
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
    send(proc, "session/new", { cwd: process.cwd(), mcpServers: [] }),
    60000,
    "session/new",
  );
  if (created.error) {
    if (looksLikeAuthFailure(created.error.message)) skip(`pi auth: ${created.error.message}`);
    fail(`session/new: ${created.error.message}`);
  }
  const sessionId = created.result?.sessionId;
  console.log("ok: session/new ->", sessionId);

  // ── Phase 1: allow ──
  updates.length = 0;
  permRequests.length = 0;
  policy = (msg) => {
    const tc = msg.params?.toolCall ?? {};
    const opts = (msg.params?.options ?? []).map((o) => o.kind);
    if (!tc.toolCallId || !tc.title || !tc.rawInput) {
      fail(`malformed permission request: ${JSON.stringify(msg.params).slice(0, 200)}`);
    }
    if (!opts.includes("allow_once") || !opts.includes("reject_once")) {
      fail(`permission options missing kinds: ${JSON.stringify(opts)}`);
    }
    // Spec-shaped Crew answer: nested outcome object.
    respond(proc, msg.id, { outcome: { outcome: "selected", optionId: "once" } });
  };
  const p1 = await withTimeout(
    send(proc, "session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "You must use the bash tool to run exactly this command and nothing else: echo slice3-tool-ok. Afterwards reply with DONE on its own line.",
        },
      ],
    }),
    180000,
    "prompt(allow)",
  );
  if (p1.error) fail(`prompt(allow): ${p1.error.message}`);
  if (p1.result?.stopReason !== "end_turn") fail(`stopReason = ${JSON.stringify(p1)}`);
  if (permRequests.length === 0) {
    fail("allow prompt ran no tool — model skipped bash (set PI_ACP_MODEL to a tool-capable model)");
  }
  const asked = permRequests[0]?.toolCall ?? {};
  console.log(`ok: asked for ${asked.title} rawInput=${JSON.stringify(asked.rawInput).slice(0, 100)}`);
  if (asked.title !== "bash") fail(`expected bash tool, got ${asked.title}`);
  const toolUpdates = updates.filter((u) => u.update?.sessionUpdate === "tool_call_update");
  const completed = toolUpdates.find((u) => u.update?.status === "completed");
  const completedText = JSON.stringify(completed ?? {});
  if (!completed || !completedText.includes("slice3-tool-ok")) {
    fail(`no completed update carrying command output: ${completedText.slice(0, 200)}`);
  }
  const chat1 = updates
    .filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
    .map((u) => u.update?.content?.text ?? "")
    .join("");
  if (!/DONE/i.test(chat1)) fail(`expected DONE in chat: ${JSON.stringify(chat1.slice(0, 200))}`);
  console.log("ok: allow ran the command, output reached Crew frames");

  // ── Phase 2: deny ──
  updates.length = 0;
  permRequests.length = 0;
  policy = (msg) => {
    respond(proc, msg.id, { outcome: { outcome: "cancelled" } });
  };
  const p2 = await withTimeout(
    send(proc, "session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "You must use the bash tool to run exactly this command and nothing else: echo slice3-denied-probe. Afterwards reply with DONE2 on its own line.",
        },
      ],
    }),
    180000,
    "prompt(deny)",
  );
  if (p2.error) fail(`prompt(deny): ${p2.error.message}`);
  if (p2.result?.stopReason !== "end_turn") fail(`deny stopReason = ${JSON.stringify(p2)}`);
  if (permRequests.length === 0) fail("deny prompt asked nothing");
  const denied = updates.filter((u) => u.update?.sessionUpdate === "tool_call_update");
  const failedFrame = denied.find((u) => u.update?.status === "failed");
  if (!failedFrame || !JSON.stringify(failedFrame).includes("Denied")) {
    fail(`no failed update carrying the denial: ${JSON.stringify(denied).slice(0, 300)}`);
  }
  const ranOutput = denied.some((u) => JSON.stringify(u).includes("slice3-denied-probe") && u.update?.status === "completed");
  if (ranOutput) fail("denied command output arrived as completed — gate bypassed");
  console.log("ok: deny blocked fail-safe, turn still ended");

  console.log("\nSLICE 3 PASS");
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
