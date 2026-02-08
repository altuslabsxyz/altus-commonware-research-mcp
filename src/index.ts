import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_PORT } from "./config.js";
import { registerTools } from "./tools/index.js";
import { createHttpServer, shutdown } from "./server.js";

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server Setup
// ─────────────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "altus-tutor-mcp", version: "1.0.0" });

// Register all tools
registerTools(server);

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────
const httpServer = createHttpServer(server);

httpServer.listen(MCP_PORT, () => {
  console.error(`altus-tutor-mcp running on http://localhost:${MCP_PORT}`);
  console.error(`  MCP endpoint: POST http://localhost:${MCP_PORT}/mcp`);
  console.error(`  Health check: GET  http://localhost:${MCP_PORT}/health`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────
process.on("SIGINT", async () => {
  await shutdown(httpServer);
  process.exit(0);
});
