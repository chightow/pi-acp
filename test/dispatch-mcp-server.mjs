/**
 * Slice 11 stub: dispatch-shaped stdio MCP server.
 *
 * Mirrors Crew's `member_dispatch_session_server` entry shape
 * (`members.py`): the server is spawned with an env ARRAY carrying
 * `KIROCREW_SESSION_KEY` (strict per-session identity) +
 * `KIROCREW_BOUND_PORT` (transient bound port) plus a managed-home var.
 *
 * Spawn-time assertion: argv[2]/argv[3] carry the expected sentinel values
 * (the test passes the same strings as the env array values). The stub
 * compares with `===` — byte-identical, no trimming, no filtering — and
 * exits non-zero on mismatch, so a mangled/filtered env fails session/new
 * instead of silently running as the wrong identity. The tool result echoes
 * both values back so the test can assert end-to-end delivery through the
 * permission gate.
 *
 * One dispatch verb (`session_create`, the primary dispatch tool) keeps the
 * model prompt deterministic — the slice-4 single-tool precedent. Its pi
 * name is `mcp__kirocrew-dashboard__session_create` (hyphenated server +
 * dispatch verb), which is the name-length/shape case the brief asks about.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const expectedKey = process.argv[2] ?? "";
const expectedPort = process.argv[3] ?? "";

const actualKey = process.env.KIROCREW_SESSION_KEY;
const actualPort = process.env.KIROCREW_BOUND_PORT;

if (actualKey !== expectedKey) {
  console.error(
    `[dispatch-stub] KIROCREW_SESSION_KEY mismatch: expected ${JSON.stringify(expectedKey)} got ${JSON.stringify(actualKey)}`,
  );
  process.exit(2);
}
if (actualPort !== expectedPort) {
  console.error(
    `[dispatch-stub] KIROCREW_BOUND_PORT mismatch: expected ${JSON.stringify(expectedPort)} got ${JSON.stringify(actualPort)}`,
  );
  process.exit(2);
}

const server = new Server({ name: "kirocrew-dashboard", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "session_create",
      description: "Create a worker session for the given task (member dispatch verb).",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "Task for the worker session" } },
        required: ["task"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [
    {
      type: "text",
      text: `dispatch-ok:${req.params.arguments?.task ?? ""}:key=${process.env.KIROCREW_SESSION_KEY ?? "unset"}:port=${process.env.KIROCREW_BOUND_PORT ?? "unset"}`,
    },
  ],
}));

await server.connect(new StdioServerTransport());
