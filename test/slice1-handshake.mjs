/**
 * Slice 1 acceptance: mimics KiroCrew `acp/client.py._initialize_session`
 * closely enough to prove the wire contract:
 *   initialize -> session/new (checks protocolVersion, sessionId,
 *   model+mode configOptions) -> set_config_option(mode=read-only)
 *   -> session/prompt (collects session/update, expects stopReason)
 *   -> unknown method returns -32601 (honest non-implementer)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");

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
  const proc = spawn(process.execPath, [ADAPTER], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PI_ACP_ECHO: "1" },
  });
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

  // 1. initialize
  const init = await send(proc, "initialize", {
    protocolVersion: 1,
    clientInfo: { name: "slice1-test", version: "0.0.0" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  if (init.result?.protocolVersion !== 1) fail(`protocolVersion = ${JSON.stringify(init.result)}`);
  console.log("ok: initialize ->", JSON.stringify(init.result.agentInfo));

  // 2. session/new
  const created = await send(proc, "session/new", { cwd: process.cwd(), mcpServers: [] });
  const sessionId = created.result?.sessionId;
  if (!sessionId) fail(`no sessionId: ${JSON.stringify(created)}`);
  const ids = (created.result?.configOptions ?? []).map((o) => o.id);
  if (!ids.includes("model") || !ids.includes("mode")) fail(`configOptions missing model/mode: ${ids}`);
  console.log("ok: session/new ->", sessionId);

  // 3. set_config_option(mode=read-only) — the SESSION_CONFIG routing assert
  await send(proc, "session/set_config_option", { sessionId, configId: "mode", value: "read-only" });
  console.log("ok: set_config_option(mode=read-only)");

  // 4. session/prompt
  const promptP = send(proc, "session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "hello slice1" }],
  });
  const promptRes = await promptP;
  if (promptRes.result?.stopReason !== "end_turn") fail(`stopReason = ${JSON.stringify(promptRes)}`);
  const chunks = updates.filter((u) => u.update?.sessionUpdate === "agent_message_chunk");
  if (chunks.length === 0) fail("no agent_message_chunk received");
  console.log("ok: session/prompt ->", JSON.stringify(chunks[0].update.content).slice(0, 80));

  // 5. honest -32601
  const unknown = await send(proc, "session/set_mode", { sessionId, modeId: "x" });
  if (unknown.error?.code !== -32601) fail(`expected -32601, got ${JSON.stringify(unknown)}`);
  console.log("ok: unknown method -> -32601");

  console.log("\nSLICE 1 PASS");
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
