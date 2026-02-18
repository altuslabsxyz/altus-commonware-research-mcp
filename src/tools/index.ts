import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLoginTool, registerRefreshAuthTool } from "./setup-auth.js";
import { registerQueryTool } from "./query.js";
import { registerSearchImplementationTool } from "./implementation.js";
import { registerSuggestionTool } from "./suggestion.js";
import { registerFactCheckTool } from "./factcheck.js";
import { registerSelectRepositoriesTool } from "./repo-selection.js";

export function registerTools(server: McpServer): void {
  registerLoginTool(server);
  registerRefreshAuthTool(server);
  registerQueryTool(server);
  registerSearchImplementationTool(server);
  registerSuggestionTool(server);
  registerFactCheckTool(server);
  registerSelectRepositoriesTool(server);
}
