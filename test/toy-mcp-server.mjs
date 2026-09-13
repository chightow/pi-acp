/**
 * Toy MCP server (stdio) for slice 4: one tool `echo_text` returning its
 * input plus a secret read from env at spawn — proves Crew-shaped elements
 * (command/args/env array) connect, list, and call through the bridge.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "toy", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo_text",
      description: "Echo back the given text with the server secret.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "Text to echo" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [
    {
      type: "text",
      text: `toy-echo:${req.params.arguments?.text ?? ""}:secret=${process.env.TOY_SECRET ?? "unset"}`,
    },
  ],
}));

await server.connect(new StdioServerTransport());
