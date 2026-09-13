/**
 * MCP bridge: connect to the `mcpServers` array KiroCrew sends on
 * `session/new` and expose each remote tool as a pi custom tool.
 *
 * Pi has no built-in MCP (intentional — "build it as extension"), so this
 * is the piece that makes Crew's own tools (kirocrew-core, kirocrew-cron, …)
 * callable by the pi model at all.
 *
 * Transports: stdio (primary — what Crew sends), http, sse.
 * Auth model: servers arrive pre-configured with env/headers from Crew;
 * nothing is read from ambient pi config for them.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerDef } from "./acp.js";

export interface BridgedTool {
  /** pi tool name: mcp__<server>__<tool>, sanitized like codex's fold. */
  piName: string;
  serverName: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface McpConnection {
  serverName: string;
  client: Client;
  transport: { close?: () => Promise<void> | void };
  tools: BridgedTool[];
}

export function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unnamed";
}

function envArrayToRecord(
  env: Array<{ name: string; value: string }> | Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {};
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const e of env) out[e.name] = e.value;
    return out;
  }
  return env;
}

function serverKind(def: McpServerDef): "stdio" | "http" | "sse" | "unknown" {
  const d = def as Record<string, any>;
  const t = typeof d.type === "string" ? d.type.toLowerCase() : "";
  if (t === "http") return "http";
  if (t === "sse") return "sse";
  if (t === "stdio") return "stdio";
  if (typeof d.url === "string") return "http";
  if (typeof d.command === "string") return "stdio";
  return "unknown";
}

export async function connectMcpServer(def: McpServerDef): Promise<McpConnection | null> {
  const d = def as Record<string, any>;
  const serverName = typeof d.name === "string" ? d.name : "unnamed";
  const kind = serverKind(def);

  const client = new Client({ name: "pi-acp", version: "0.1.0" }, { capabilities: {} });
  try {
    if (kind === "stdio") {
      const transport = new StdioClientTransport({
        command: d.command,
        args: Array.isArray(d.args) ? d.args : [],
        env: { ...process.env, ...envArrayToRecord(d.env) } as Record<string, string>,
        stderr: "ignore",
      });
      await client.connect(transport);
      const tools = await listBridgedTools(client, serverName);
      return { serverName, client, transport, tools };
    }
    if (kind === "http" || kind === "sse") {
      const url = new URL(d.url);
      const headers: Record<string, string> = {};
      const rawHeaders = d.headers;
      if (Array.isArray(rawHeaders)) {
        for (const h of rawHeaders) headers[h.name] = h.value;
      } else if (rawHeaders && typeof rawHeaders === "object") {
        Object.assign(headers, rawHeaders);
      }
      // Authorization-style credential headers ride the element itself —
      // nothing is inherited from ambient env.
      const transport =
        kind === "http"
          ? new StreamableHTTPClientTransport(url, { requestInit: { headers } })
          : new SSEClientTransport(url, { requestInit: { headers } });
      await client.connect(transport);
      const tools = await listBridgedTools(client, serverName);
      return { serverName, client, transport, tools };
    }
    // Unknown shape: skip rather than fail session/new whole (unlike
    // codex-acp's fatal sse — we choose availability + log, Crew's
    // session_mcp already filters by advertised capabilities).
    console.error(`[pi-acp] skipping MCP server ${JSON.stringify(serverName)}: unknown shape`);
    return null;
  } catch (err) {
    console.error(`[pi-acp] MCP connect failed for ${serverName}: ${(err as Error).message}`);
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function listBridgedTools(client: Client, serverName: string): Promise<BridgedTool[]> {
  const res = await client.listTools().catch(() => ({ tools: [] as any[] }));
  const out: BridgedTool[] = [];
  for (const t of res.tools ?? []) {
    out.push({
      piName: `mcp__${sanitizeName(serverName)}__${sanitizeName(t.name)}`,
      serverName,
      remoteName: t.name,
      description: t.description ?? `${serverName}/${t.name}`,
      inputSchema:
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Record<string, any>)
          : { type: "object", properties: {} },
    });
  }
  return out;
}

export async function callBridgedTool(
  conn: McpConnection,
  remoteName: string,
  args: Record<string, any>,
): Promise<{ contentText: string; raw: any }> {
  const res = await conn.client.callTool({ name: remoteName, arguments: args });
  const r = res as unknown as Record<string, any>;
  const blocks: string[] = [];
  const content = Array.isArray(r.content) ? r.content : [];
  for (const b of content) {
    if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
      blocks.push(b.text);
    } else if (b && typeof b === "object") {
      blocks.push(JSON.stringify(b));
    }
  }
  return { contentText: blocks.join("\n"), raw: res };
}

export async function closeMcpConnection(conn: McpConnection): Promise<void> {
  try {
    await conn.client.close();
  } catch {
    /* ignore */
  }
  try {
    await conn.transport.close?.();
  } catch {
    /* ignore */
  }
}
