/**
 * Slice 10 acceptance: ACP `session/load` resume parity (the opencode
 * two-process precedent).
 *   process A: initialize (loadSession:true) -> session/new -> prompt
 *     (tool-free prose establishing a secret word) -> exit.
 *   process B (fresh adapter process, SAME store via PI_ACP_SESSION_DIR):
 *     initialize (loadSession:true) -> session/load unknown id (ERROR) ->
 *     session/load known id + wrong cwd (ERROR, fail-closed) ->
 *     session/load same id + same cwd (OK: same sessionId, configOptions,
 *     no `modes` block) -> prompt referencing earlier content (continuity:
 *     secret word present) -> session/new (fresh id, no collision).
 *
 * Skips (exit 0, "SKIP") on pi auth failure — CI without keys must not go red.
 * Keyless echo path (PI_ACP_ECHO=1): single-process wire checks only
 * (initialize advertises, echo new -> echo load same id OK, unknown ERROR).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.join(HERE, "..", "dist", "index.js");

const ECHO_MODE = process.env.PI_ACP_ECHO === "1";

const skip = (why) => {
  console.log(`SKIP: ${why} (slice 1 is the keyless gate)`);
  process.exit(0);
};
const looksLikeAuthFailure = (msg) =>
  /api.?key|auth|sign.?in|credential|unauthorized|forbidden|401|403/i.test(String(msg ?? ""));

function makeClient(envExtra = {}) {
  const proc = spawn(process.execPath, [ADAPTER], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...envExtra },
  });
  let nextId = 1;
  const pending = new Map();
  const updates = [];
  const waiters = [];
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
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
      } else {
        // Unhandled server->client request (e.g. permission ask with no
        // tool use expected here): fail-safe reject so nothing hangs.
        if (msg.method && msg.id !== undefined) {
          try {
            proc.stdin.write(
              JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "no handler in test" } }) + "\n",
            );
          } catch {
            /* ignore */
          }
        }
      }
    }
  });
  const send = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  const withTimeout = (p, ms, what) =>
    Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms)),
    ]);
  return {
    proc,
    updates,
    send: (method, params, ms = 30000, what = method) => withTimeout(send(method, params), ms, what),
    close() {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

function assertConfigOptions(result, sessionId, label) {
  const fail = (m) => {
    throw new Error(`${label}: ${m}`);
  };
  if (result?.sessionId !== sessionId) fail(`sessionId = ${JSON.stringify(result?.sessionId)}, want ${sessionId}`);
  const ids = (result?.configOptions ?? []).map((o) => o?.id);
  for (const need of ["model", "mode", "effort"]) {
    if (!ids.includes(need)) fail(`configOptions missing ${need}: ${JSON.stringify(ids)}`);
  }
  if ("modes" in (result ?? {})) fail(`load result must not carry a modes block (LOAD_WITHOUT_MODES precedent)`);
}

function collectChat(updates, sessionId) {
  return updates
    .filter((m) => m.params?.sessionId === sessionId && m.params?.update?.sessionUpdate === "agent_message_chunk")
    .map((m) => m.params?.update?.content?.text ?? "")
    .join("");
}

async function main() {
  const fail = (m) => {
    console.error(`FAIL: ${m}`);
    process.exit(1);
  };

  if (ECHO_MODE) {
    // Keyless wire checks only: echo sessions live in-process, so load of a
    // live echo id succeeds and unknown ids error.
    const c = makeClient();
    try {
      const init = await c.send("initialize", { protocolVersion: 1 }, 15000, "initialize");
      if (init.result?.agentCapabilities?.loadSession !== true) fail("initialize must advertise loadSession:true");
      console.log("ok: initialize advertises loadSession:true (echo)");
      const created = await c.send("session/new", { cwd: process.cwd(), mcpServers: [] }, 15000, "session/new");
      if (created.error) fail(`session/new: ${created.error.message}`);
      const sid = created.result?.sessionId;
      console.log(`ok: echo session/new -> ${sid}`);
      const loaded = await c.send("session/load", { sessionId: sid, cwd: process.cwd(), mcpServers: [] }, 15000, "session/load");
      if (loaded.error) fail(`echo load of live id: ${loaded.error.message}`);
      if (loaded.result?.sessionId !== sid) fail("echo load must reuse the requested sessionId");
      console.log("ok: echo session/load reuses sessionId");
      const unknown = await c.send(
        "session/load",
        { sessionId: "ses_pi_999999", cwd: process.cwd(), mcpServers: [] },
        15000,
        "session/load unknown",
      );
      if (!unknown.error) fail("echo load of unknown id unexpectedly succeeded");
      console.log(`ok: echo unknown id errors (${unknown.error.message})`);
      console.log("\nSLICE 10 PASS (echo wire checks)");
    } catch (e) {
      fail(e.message);
    } finally {
      c.close();
    }
    process.exit(0);
  }

  // Live two-process path. Isolated store so runs are hermetic and the
  // restart-collision check is meaningful.
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-acp-slice10-"));
  const childEnv = { PI_ACP_SESSION_DIR: storeDir };
  console.log(`store: ${storeDir}`);
  const cwd = process.cwd();

  let sessionId;
  // ── Process A ──
  {
    const a = makeClient(childEnv);
    try {
      const init = await a.send("initialize", { protocolVersion: 1 }, 15000, "initialize");
      if (init.result?.agentCapabilities?.loadSession !== true) fail("initialize must advertise loadSession:true");
      console.log("ok: A initialize advertises loadSession:true");

      const created = await a.send("session/new", { cwd, mcpServers: [] }, 60000, "session/new");
      if (created.error) {
        if (looksLikeAuthFailure(created.error.message)) {
          a.close();
          skip(`pi auth: ${created.error.message}`);
        }
        fail(`A session/new: ${created.error.message}`);
      }
      sessionId = created.result?.sessionId;
      if (!sessionId || !/^ses_pi_\d+$/.test(sessionId)) fail(`A sessionId shape: ${JSON.stringify(sessionId)}`);
      console.log(`ok: A session/new -> ${sessionId} (model ${created.result?.configOptions?.[0]?.currentValue})`);

      const p1 = await a.send(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: "Remember the secret word BLUEBIRD. Reply with exactly the word BLUEBIRD and nothing else." }],
        },
        120000,
        "session/prompt A",
      );
      if (p1.error) {
        if (looksLikeAuthFailure(p1.error.message)) {
          a.close();
          skip(`pi auth: ${p1.error.message}`);
        }
        fail(`A prompt: ${p1.error.message}`);
      }
      if (p1.result?.stopReason !== "end_turn") fail(`A stopReason = ${JSON.stringify(p1.result)}`);
      const textA = collectChat(a.updates, sessionId);
      if (!/BLUEBIRD/i.test(textA)) fail(`A reply missing BLUEBIRD: ${JSON.stringify(textA.slice(0, 200))}`);
      console.log(`ok: A prompt establishes secret word (${JSON.stringify(textA.slice(0, 60))})`);
    } catch (e) {
      a.close();
      if (/timed out/.test(e.message)) fail(e.message);
      throw e;
    } finally {
      a.close();
    }
    // Let the adapter exit and flush the transcript to disk.
    await new Promise((r) => setTimeout(r, 2000));
  }

  const files = fs.readdirSync(storeDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) fail(`no session file persisted in ${storeDir}`);
  console.log(`ok: transcript persisted (${files.join(",")})`);

  // ── Process B (fresh adapter process, same store) ──
  {
    const b = makeClient(childEnv);
    try {
      const init = await b.send("initialize", { protocolVersion: 1 }, 15000, "initialize");
      if (init.result?.agentCapabilities?.loadSession !== true) fail("B initialize must advertise loadSession:true");
      console.log("ok: B initialize advertises loadSession:true");

      const unknown = await b.send(
        "session/load",
        { sessionId: "ses_pi_999999", cwd, mcpServers: [] },
        30000,
        "session/load unknown",
      );
      if (!unknown.error) fail("load of unknown id unexpectedly succeeded");
      if (unknown.error?.code !== -32602) fail(`unknown-id error code = ${JSON.stringify(unknown.error)}, want -32602`);
      console.log(`ok: unknown id errors INVALID_PARAMS (${unknown.error.message})`);

      // cwd mismatch fails closed (must not clobber or fork the transcript).
      const otherCwd = path.resolve(os.tmpdir()) === path.resolve(cwd) ? path.resolve(cwd, "..") : os.tmpdir();
      const mismatched = await b.send(
        "session/load",
        { sessionId, cwd: otherCwd, mcpServers: [] },
        60000,
        "session/load cwd mismatch",
      );
      if (!mismatched.error) fail("load with mismatched cwd unexpectedly succeeded");
      console.log(`ok: cwd mismatch errors fail-closed (${mismatched.error.message})`);

      const loaded = await b.send("session/load", { sessionId, cwd, mcpServers: [] }, 60000, "session/load");
      if (loaded.error) {
        if (looksLikeAuthFailure(loaded.error.message)) {
          b.close();
          skip(`pi auth on load: ${loaded.error.message}`);
        }
        fail(`B session/load: ${loaded.error.message}`);
      }
      assertConfigOptions(loaded.result, sessionId, "session/load envelope");
      console.log(`ok: B session/load reuses ${sessionId} with configOptions, no modes block`);

      const p2 = await b.send(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: "What is the secret word I asked you to remember? Reply with exactly that word and nothing else." }],
        },
        120000,
        "session/prompt B",
      );
      if (p2.error) {
        if (looksLikeAuthFailure(p2.error.message)) {
          b.close();
          skip(`pi auth: ${p2.error.message}`);
        }
        fail(`B prompt: ${p2.error.message}`);
      }
      if (p2.result?.stopReason !== "end_turn") fail(`B stopReason = ${JSON.stringify(p2.result)}`);
      const textB = collectChat(b.updates, sessionId);
      if (!/BLUEBIRD/i.test(textB)) fail(`continuity broken, B reply missing BLUEBIRD: ${JSON.stringify(textB.slice(0, 300))}`);
      console.log(`ok: resumed session shows continuity (${JSON.stringify(textB.slice(0, 80))})`);

      // Fresh ids never collide with the loaded one across the restart.
      const fresh = await b.send("session/new", { cwd, mcpServers: [] }, 60000, "session/new after load");
      if (fresh.error) fail(`post-load session/new: ${fresh.error.message}`);
      const freshId = fresh.result?.sessionId;
      if (!freshId || freshId === sessionId) fail(`post-load new id collides: ${JSON.stringify(freshId)}`);
      const nOld = parseInt(sessionId.split("_").pop(), 10);
      const nNew = parseInt(String(freshId).split("_").pop(), 10);
      if (Number.isFinite(nOld) && Number.isFinite(nNew) && nNew <= nOld) {
        fail(`post-load new id ${freshId} not above loaded ${sessionId} (restart reissue)`);
      }
      console.log(`ok: post-load session/new mints fresh ${freshId} (no reissue)`);
    } finally {
      b.close();
    }
  }

  try {
    fs.rmSync(storeDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log("\nSLICE 10 PASS");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
