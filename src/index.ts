import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { closeClient, preloadAuth } from "./notebooklm/index.js";
import { preloadTrees } from "./github/index.js";
import { closeDb } from "./db/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server (stdio transport)
// ─────────────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "altus-tutor-mcp", version: "1.0.0" });
registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("altus-tutor-mcp running (stdio)");

// Eagerly load cached auth tokens from disk (no subprocess to warm up).
preloadAuth();

// Preload repo file trees into cache so search_implementation is instant.
preloadTrees();

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  closeDb();
  await closeClient();
  await server.close();
  process.exit(0);
});
