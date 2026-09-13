/**
 * Model-catalog acceptance: the `model` select carries pi's full catalog so
 * Crew's picker can offer (and validate) every id the adapter accepts.
 *   initialize -> session/new (model select has the catalog, currentValue
 *   matches one offered value) -> set_config_option{model:current} (same-model
 *   round-trip succeeds) -> set_config_option{model:nope/not-a-model}
 *   (rejected fail-closed with the `Invalid value for config option model`
 *   shape Crew's step-down ladder recognizes).
 *
 * No prompt runs, so this spends nothing. Skips (exit 0, "SKIP") on pi auth
 * failure — CI without keys must not go red. Under PI_ACP_ECHO=1 the echo
 * path keeps the documented single-current fallback shape.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");
const ECHO = process.env.PI_ACP_ECHO === "1";

const skip = (why) => {
  console.log(`SKIP: ${why} (slice 1 is the keyless gate)`);
  process.exit(0);
};
const looksLikeAuthFailure = (msg) =>
  /api.?key|auth|sign.?in|credential|unauthorized|forbidden|401|403/i.test(String(msg ?? ""));

let nextId = 1;
const pending = new Map();

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
      if (msg.method !== undefined) continue; // notifications: none expected here
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
  const model = (created.result?.configOptions ?? []).find((o) => o && o.id === "model");
  if (!model || model.type !== "select") fail(`model entry not a select: ${JSON.stringify(model)}`);
  const options = model.options ?? [];
  const current = model.currentValue;
  if (typeof current !== "string" || !current) fail("model currentValue missing");

  if (ECHO) {
    // Keyless path keeps the single-current fallback (no runtime to enumerate).
    if (options.length !== 1 || options[0]?.value !== current) {
      fail(`echo model options = ${JSON.stringify(options)}, want single current`);
    }
    console.log("ok: echo keeps single-current model fallback");
  } else {
    // Live path: the catalog. Bound well above 1 so a regression to the
    // single-current shape (the session that starved the picker) goes red;
    // exact count is pi-version-dependent and deliberately unpinned.
    if (options.length < 100) fail(`model catalog has ${options.length} entries, want the full list`);
    for (const o of options) {
      if (typeof o?.value !== "string" || !o.value.includes("/")) {
        fail(`model option not provider/id shaped: ${JSON.stringify(o)}`);
      }
      if (typeof o?.name !== "string" || !o.name) fail(`model option nameless: ${JSON.stringify(o)}`);
    }
    if (!options.some((o) => o.value === current)) {
      fail(`currentValue ${JSON.stringify(current)} matches no offered value`);
    }
    console.log(`ok: model select carries the catalog (${options.length} entries, current=${current})`);

    // Same-model round-trip: the advertised value is accepted back (the
    // vocabulary property Crew's picker depends on).
    const setSame = await withTimeout(
      send(proc, "session/set_config_option", { sessionId, configId: "model", value: current }),
      30000,
      "set_config_option(model=current)",
    );
    if (setSame.error) fail(`set model=current: ${setSame.error.message}`);
    console.log("ok: set_config_option(model=current) accepted");

    // Unknown id fails closed with the ladder-recognized message.
    const setBogus = await withTimeout(
      send(proc, "session/set_config_option", { sessionId, configId: "model", value: "nope/not-a-model" }),
      30000,
      "set_config_option(model=bogus)",
    );
    if (!setBogus.error) fail("bogus model unexpectedly accepted");
    if (!String(setBogus.error.message ?? "").includes("Invalid value for config option model")) {
      fail(`bogus rejection has wrong shape: ${setBogus.error.message}`);
    }
    console.log("ok: unknown model rejected fail-closed");
  }

  console.log("\nMODEL-LIST PASS");
  proc.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
