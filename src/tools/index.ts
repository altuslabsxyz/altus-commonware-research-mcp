import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthorizeTool } from "./authorize.js";
import { registerResearchTool } from "./research.js";
import { registerGetPageTool } from "./get-page.js";

// ─────────────────────────────────────────────────────────────────────────────
// Register All Tools
// ─────────────────────────────────────────────────────────────────────────────

export function registerTools(server: McpServer): void {
  registerAuthorizeTool(server);
  registerResearchTool(server);
  registerGetPageTool(server);
}
