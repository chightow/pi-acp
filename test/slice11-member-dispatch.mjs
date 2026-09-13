/**
 * Slice 11 acceptance: member-dispatch mount parity.
 *
 * A member DM session mounts Crew's session-control server as a per-session
 * MCP entry shaped like `member_dispatch_session_server` (members.py):
 * `{name:"kirocrew-dashboard", command, args, env:[{name,value}...],
 * type:"stdio"}` with `KIROCREW_SESSION_KEY` + `KIROCREW_BOUND_PORT`.
 *
 * Proves, end to end over `session/new` (session/load re-declaration is
 * slice 10's territory and is NOT exercised here):
 *  1. the TAGGED stdio path (`type:"stdio"` explicit — slice 4 only tested
 *     the untagged `command`-fallback path) connects and lists the dispatch
 *     tool as `mcp__kirocrew-dashboard__*`;
 *  2. the env array arrives byte-identical (stub asserts on spawn AND echoes
 *     both sentinels in the tool result — a wrong port/identity fails every
 *     dispatch verb as caller_unidentified/refused);
 *  3. the dispatch tool answers through the permission gate like any other:
 *     `mode=read-only` means the verb ASKS (once-allow here) — never
 *     pre-approved — and the result returns in the completed update.
 *
 * Requires PI_ACP_MODEL with real tool calls (same note as slices 3/4).
 * Auth failure -> SKIP.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");
const DISPATCH_STUB = path.join(HERE, "dispatch-mcp-server.mjs");

// Sentinel identity + port: sent as env-array values AND as stub argv so the
// stub can assert byte-identical delivery on spawn.
const SESSION_KEY = "sk-test-member-001";
const BOUND_PORT = "18731";
const DISPATCH_TOOL = "mcp__kirocrew-dashboard__session_create";

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
        // Dispatch verbs ASK, never pre-approved (mode=read-only): allow once.
        respond(proc, msg.id, { outcome: { outcome: "selected", optionId: "once" } });
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

  // 60s ceiling: cold-start import of the pi SDK can exceed slice-4's 15s.
  await withTimeout(send(proc, "initialize", { protocolVersion: 1 }), 60000, "initialize");

  // Dispatch-shaped entry: hyphenated server name, explicit tagged stdio
  // type, env ARRAY with managed-home var + session key + bound port.
  const created = await withTimeout(
    send(proc, "session/new", {
      cwd: process.cwd(),
      mcpServers: [
        {
          name: "kirocrew-dashboard",
          command: process.execPath,
          args: [DISPATCH_STUB, SESSION_KEY, BOUND_PORT],
          env: [
            { name: "KIROCREW_HOME", value: "/tmp/kirocrew-home-slice11" },
            { name: "KIROCREW_SESSION_KEY", value: SESSION_KEY },
            { name: "KIROCREW_BOUND_PORT", value: BOUND_PORT },
          ],
          type: "stdio",
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

  // Frozen contract guard: the session still advertises mode=read-only
  // (dispatch verbs ASK; nothing pre-approved).
  const modes = JSON.stringify(created.result?.configOptions ?? []);
  if (!modes.includes("read-only")) fail(`mode=read-only missing from session/new: ${modes.slice(0, 200)}`);
  console.log("ok: mode=read-only advertised");

  const res = await withTimeout(
    send(proc, "session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: `You must call the tool named ${DISPATCH_TOOL} with task set to slice11-dispatch-ok, and nothing else. Afterwards reply with MDISPATCH on its own line.`,
        },
      ],
    }),
    180000,
    "session/prompt",
  );
  if (res.error) {
    if (looksLikeAuthFailure(res.error.message)) skip(`pi auth: ${res.error.message}`);
    fail(`session/prompt: ${res.error.message}`);
  }
  if (res.result?.stopReason !== "end_turn") fail(`stopReason = ${JSON.stringify(res)}`);

  // The dispatch tool reached the gate: a permission ask for the exact
  // dispatch-shaped pi name (NOT pre-approved — an ask happened).
  const asked = permRequests.map((p) => p?.toolCall?.title);
  if (!asked.includes(DISPATCH_TOOL)) {
    fail(`dispatch tool never asked permission (asked: ${JSON.stringify(asked)}) — model skipped ${DISPATCH_TOOL} (check PI_ACP_MODEL + promptSnippet)`);
  }
  console.log("ok: dispatch tool asked permission (ASK, not pre-approved)");

  // Bridged tools are opaque third-party tools, not shell: kind must be
  // "other", never the execute branch.
  const kinds = permRequests
    .filter((p) => p?.toolCall?.title === DISPATCH_TOOL)
    .map((p) => p?.toolCall?.kind);
  if (!kinds.includes("other")) {
    fail(`dispatch permission kind = ${JSON.stringify(kinds)}, expected "other"`);
  }
  console.log('ok: dispatch permission kind is "other"');

  // The completed update carries the dispatch output incl. byte-identical env.
  const completed = updates.find(
    (u) =>
      u.update?.sessionUpdate === "tool_call_update" &&
      u.update?.status === "completed" &&
      JSON.stringify(u).includes("dispatch-ok:slice11-dispatch-ok"),
  );
  if (!completed) {
    const flat = JSON.stringify(updates.filter((u) => String(JSON.stringify(u)).includes("tool_call")).slice(0, 3));
    fail(`dispatch result missing from completed updates: ${flat.slice(0, 300)}`);
  }
  const flat = JSON.stringify(completed);
  if (!flat.includes(`key=${SESSION_KEY}`)) fail(`KIROCREW_SESSION_KEY not byte-identical in result: ${flat.slice(0, 250)}`);
  if (!flat.includes(`port=${BOUND_PORT}`)) fail(`KIROCREW_BOUND_PORT not byte-identical in result: ${flat.slice(0, 250)}`);
  console.log("ok: dispatch result + byte-identical env reached Crew frames");

  const chat = updates
    .filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
    .map((u) => u.update?.content?.text ?? "")
    .join("");
  if (!/MDISPATCH/i.test(chat)) fail(`expected MDISPATCH in chat: ${JSON.stringify(chat.slice(0, 200))}`);

  console.log("\nSLICE 11 PASS");
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
