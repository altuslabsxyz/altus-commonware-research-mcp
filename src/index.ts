import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { closeClient, getClient } from "./notebooklm/index.js";
import { preloadTrees } from "./github/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server (stdio transport)
// ─────────────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "altus-tutor-mcp", version: "1.0.0" });
registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("altus-tutor-mcp running (stdio)");

// Eagerly start the notebooklm-mcp subprocess so the first query doesn't pay
// the cold-start cost. Fire-and-forget — a failure here is not fatal since
// getClient() will retry lazily on the first actual query.
getClient().catch((e) => console.error("notebooklm-mcp pre-connect failed:", e));

// Preload repo file trees into cache so search_implementation is instant.
preloadTrees();

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  await closeClient();
  await server.close();
  process.exit(0);
});
