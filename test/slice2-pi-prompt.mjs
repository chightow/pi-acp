/**
 * Slice 2 acceptance: real pi turn end-to-end.
 *   initialize -> session/new (boots pi; FAILS fast with pi auth error if
 *   no provider key) -> session/prompt("Reply with exactly slice2-ok")
 *   -> expects agent_message_chunk stream + stopReason end_turn containing it.
 *
 * Skips (exit 0, "SKIP") when no provider key is in env — CI without keys
 * must not go red. Slice 1 remains the keyless gate.
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

  const init = await withTimeout(
    send(proc, "initialize", { protocolVersion: 1 }),
    15000,
    "initialize",
  );
  if (init.result?.protocolVersion !== 1) fail("initialize");
  console.log("ok: initialize");

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
  const currentModel = created.result?.configOptions?.[0]?.currentValue;
  console.log("ok: session/new ->", sessionId, `(model ${currentModel})`);

  // Same-model switch exercises set_config_option("model") -> pi setModel
  // without spending a second model's turn.
  const switched = await withTimeout(
    send(proc, "session/set_config_option", { sessionId, configId: "model", value: currentModel }),
    30000,
    "set_config_option(model)",
  );
  if (switched.error) fail(`set_config_option(model): ${switched.error.message}`);
  console.log("ok: set_config_option(model) round-trips");

  const promptRes = await withTimeout(
    send(proc, "session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: "Reply with exactly the word slice2-ok and nothing else." }],
    }),
    120000,
    "session/prompt",
  );
  if (promptRes.error) fail(`session/prompt: ${promptRes.error.message}`);
  if (promptRes.result?.stopReason !== "end_turn") fail(`stopReason = ${JSON.stringify(promptRes)}`);

  const text = updates
    .filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
    .map((u) => u.update?.content?.text ?? "")
    .join("");
  const thought = updates
    .filter((u) => u.update?.sessionUpdate === "agent_thought_chunk")
    .map((u) => u.update?.content?.text ?? "")
    .join("");
  console.log("ok: prompt turn ->", JSON.stringify(text.slice(0, 120)));
  if (/reply with exactly/i.test(text)) fail(`user prompt leaked into chat: ${JSON.stringify(text.slice(0, 200))}`);
  if (!/slice2-ok/i.test(text)) fail(`expected slice2-ok in ${JSON.stringify(text.slice(0, 200))}`);
  console.log(`ok: thought chunks streamed separately (${thought.length} chars, not in chat)`);

  // Slice 6: one usage_update per turn, flat used/size with a real window.
  const usageFrames = updates.filter((u) => u.update?.sessionUpdate === "usage_update");
  if (usageFrames.length !== 1) fail(`expected exactly 1 usage_update, got ${usageFrames.length}`);
  const uu = usageFrames[0].update;
  const { used, size } = uu;
  if (!Number.isFinite(used) || used <= 0) fail(`usage_update.used invalid: ${JSON.stringify(uu)}`);
  if (!Number.isFinite(size) || size <= 0) fail(`usage_update.size invalid: ${JSON.stringify(uu)}`);
  if (used > size) fail(`usage_update.used ${used} > size ${size}`);
  console.log(`ok: usage_update used=${used} size=${size}${uu.cost ? ` cost=${uu.cost.amount}${uu.cost.currency}` : " (no cost: provider silent)"}`);

  // Turn-scoped token counts appear on the response ONLY when the provider
  // reported usage; otherwise the keys are absent (kiro parity).
  const counts = ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens"];
  const present = counts.filter((k) => promptRes.result?.[k] !== undefined);
  if (present.length !== 0 && present.length !== 4) {
    fail(`partial token counts on response: ${JSON.stringify(promptRes.result)}`);
  }
  if (present.length === 4) {
    for (const k of present) {
      if (!Number.isFinite(promptRes.result[k]) || promptRes.result[k] < 0) {
        fail(`token count ${k} invalid: ${JSON.stringify(promptRes.result)}`);
      }
    }
    console.log(`ok: response token counts input=${promptRes.result.inputTokens} output=${promptRes.result.outputTokens}`);
  } else {
    console.log("ok: response token counts absent (provider silent on usage — the kiro path)");
  }

  console.log("\nSLICE 2 PASS");
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
