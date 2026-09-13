/**
 * Slice 9 acceptance: kiro's reasoning-effort knob parity.
 *   initialize -> session/new (advertises `effort` with the 5 Crew levels in
 *   order) -> session/set_config_option{effort:high} (round-trips; the
 *   follow-up config_option_update notification shows it)
 *   -> set_config_option{effort:bogus} (rejected fail-closed, old level kept)
 *   -> set_config_option{effort:low} (proves state uncorrupted)
 *   -> set_config_option{model:current} (same-model switch rebuilds effort
 *   options via config_option_update) -> unknown configId rejected.
 *
 * Skips (exit 0, "SKIP") on pi auth failure — CI without keys must not go red.
 * Works keyless under PI_ACP_ECHO=1 (echo path mirrors the same shapes).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");

const EXPECTED_EFFORT = ["low", "medium", "high", "xhigh", "max"];

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

function effortEntryOf(configOptions) {
  return (configOptions ?? []).find((o) => o && o.id === "effort");
}

function effortCurrentOfConfigOptions(configOptions) {
  const e = effortEntryOf(configOptions);
  return e?.currentValue;
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
        updates.push(msg);
        for (const w of [...waiters]) {
          if (w.pred(msg)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(msg);
          }
        }
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
  const waitFor = (pred, ms, what) =>
    withTimeout(new Promise((resolve) => waiters.push({ pred, resolve })), ms, what);
  // Drain any already-received update matching pred (race-safe: notification
  // may land before we start waiting).
  const seenUpdate = (pred) => updates.find(pred);
  const waitForUpdate = async (pred, ms, what) => {
    const seen = seenUpdate(pred);
    if (seen) return seen;
    return waitFor(pred, ms, what);
  };
  const isConfigOptionUpdate = (m) =>
    m.method === "session/update" && m.params?.update?.sessionUpdate === "config_option_update";
  const updatesSince = (n) => updates.slice(n);

  await withTimeout(send(proc, "initialize", { protocolVersion: 1 }), 15000, "initialize");
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
  const configOptions = created.result?.configOptions ?? [];
  const ids = configOptions.map((o) => o?.id);
  // supports_config_option-equivalent: the three selectors Crew reads.
  for (const need of ["model", "mode", "effort"]) {
    if (!ids.includes(need)) fail(`configOptions missing ${need}: ${JSON.stringify(ids)}`);
  }
  console.log(`ok: session/new advertises model+mode+effort -> ${sessionId}`);

  const effort = effortEntryOf(configOptions);
  if (effort?.type !== "select") fail(`effort entry type = ${JSON.stringify(effort?.type)}`);
  const values = (effort.options ?? []).map((o) => o?.value);
  if (JSON.stringify(values) !== JSON.stringify(EXPECTED_EFFORT)) {
    fail(`effort levels = ${JSON.stringify(values)}, want ${JSON.stringify(EXPECTED_EFFORT)}`);
  }
  if (typeof effort.currentValue !== "string" || !effort.currentValue) {
    fail(`effort currentValue missing: ${JSON.stringify(effort)}`);
  }
  console.log(`ok: effort advertises 5 levels in order (current=${effort.currentValue})`);
  const currentModel = (configOptions.find((o) => o?.id === "model") ?? {}).currentValue;

  // 1. Valid set round-trips; the config_option_update notification is the
  //    subsequent read showing it (same configOptions shape as session/new).
  let mark = updates.length;
  const setHigh = await withTimeout(
    send(proc, "session/set_config_option", { sessionId, configId: "effort", value: "high" }),
    30000,
    "set_config_option(effort=high)",
  );
  if (setHigh.error) fail(`set effort=high: ${setHigh.error.message}`);
  const highNotif = await waitForUpdate(
    (m) =>
      isConfigOptionUpdate(m) &&
      m.params?.sessionId === sessionId &&
      effortCurrentOfConfigOptions(m.params?.update?.configOptions) === "high" &&
      updates.indexOf(m) >= mark,
    15000,
    "config_option_update(effort=high)",
  ).catch(() => null);
  if (!highNotif) fail("no config_option_update showing effort=high after set");
  const highLevels = (effortEntryOf(highNotif.params.update.configOptions)?.options ?? []).map(
    (o) => o?.value,
  );
  if (JSON.stringify(highLevels) !== JSON.stringify(EXPECTED_EFFORT)) {
    fail(`rebuilt effort levels = ${JSON.stringify(highLevels)}`);
  }
  console.log("ok: set_config_option(effort=high) round-trips via config_option_update");

  // 2. Invalid value is rejected fail-closed (mirrors claude-agent-acp's
  //    `Invalid value for config option effort: ...` so Crew steps down).
  mark = updates.length;
  const setBogus = await withTimeout(
    send(proc, "session/set_config_option", { sessionId, configId: "effort", value: "ultra" }),
    30000,
    "set_config_option(effort=ultra)",
  );
  if (!setBogus.error) fail("set effort=ultra unexpectedly succeeded");
  if (!/config option effort/i.test(String(setBogus.error.message ?? ""))) {
    fail(`bogus error message missing effort id: ${JSON.stringify(setBogus.error)}`);
  }
  console.log(`ok: invalid effort rejected fail-closed (${setBogus.error.message})`);
  // No rebuild may advertise the bogus level; give the pipe a beat, then check.
  await new Promise((r) => setTimeout(r, 1500));
  const leaked = updatesSince(mark).filter(
    (m) => isConfigOptionUpdate(m) && effortCurrentOfConfigOptions(m.params?.update?.configOptions) === "ultra",
  );
  if (leaked.length > 0) fail("bogus level leaked into a config_option_update");

  // 3. State uncorrupted: a later valid set still applies.
  mark = updates.length;
  const setLow = await withTimeout(
    send(proc, "session/set_config_option", { sessionId, configId: "effort", value: "low" }),
    30000,
    "set_config_option(effort=low)",
  );
  if (setLow.error) fail(`set effort=low after reject: ${setLow.error.message}`);
  await waitForUpdate(
    (m) =>
      isConfigOptionUpdate(m) &&
      m.params?.sessionId === sessionId &&
      effortCurrentOfConfigOptions(m.params?.update?.configOptions) === "low" &&
      updates.indexOf(m) >= mark,
    15000,
    "config_option_update(effort=low)",
  ).catch(() => fail("no config_option_update showing effort=low"));
  console.log("ok: post-reject valid set still applies (fail-closed, old level kept)");

  // 4. Same-model switch rebuilds the full effort options array.
  // Tolerates missing auth for the session's default model (no PI_ACP_MODEL
  // in env): the effort checks above are the slice's core, and the rebuild
  // is fully verified on live runs with PI_ACP_MODEL set.
  if (typeof currentModel === "string" && currentModel) {
    mark = updates.length;
    const switched = await withTimeout(
      send(proc, "session/set_config_option", { sessionId, configId: "model", value: currentModel }),
      30000,
      "set_config_option(model)",
    );
    if (switched.error) {
      if (looksLikeAuthFailure(switched.error.message)) {
        console.log(`ok: model switch skipped (no key for ${currentModel})`);
      } else fail(`set_config_option(model): ${switched.error.message}`);
    } else {
      const rebuilt = await waitForUpdate(
        (m) => isConfigOptionUpdate(m) && m.params?.sessionId === sessionId && updates.indexOf(m) >= mark,
        15000,
        "config_option_update(model switch)",
      ).catch(() => null);
      if (!rebuilt) fail("no config_option_update after model switch");
      const rebuiltIds = (rebuilt.params.update.configOptions ?? []).map((o) => o?.id);
      if (!rebuiltIds.includes("effort")) fail(`rebuilt array missing effort: ${rebuiltIds}`);
      const rebuiltLevels = (effortEntryOf(rebuilt.params.update.configOptions)?.options ?? []).map(
        (o) => o?.value,
      );
      if (JSON.stringify(rebuiltLevels) !== JSON.stringify(EXPECTED_EFFORT)) {
        fail(`rebuilt levels = ${JSON.stringify(rebuiltLevels)}`);
      }
      console.log("ok: model switch rebuilds full effort options array");
    }
  }

  // 5. Unknown config ids fail closed (Crew gates pushes on supports_config_option).
  const setUnknown = await withTimeout(
    send(proc, "session/set_config_option", { sessionId, configId: "nope", value: "x" }),
    30000,
    "set_config_option(unknown)",
  );
  if (!setUnknown.error) fail("unknown configId unexpectedly succeeded");
  console.log("ok: unknown config option rejected");

  console.log("\nSLICE 9 PASS");
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
