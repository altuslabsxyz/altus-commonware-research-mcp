import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLoginTool, registerRefreshAuthTool } from "./setup-auth.js";
import { registerQueryTool } from "./query.js";
import { registerSearchImplementationTool } from "./implementation.js";
import { registerSuggestionTool } from "./suggestion.js";
import { registerFactCheckTool } from "./factcheck.js";
import { registerSelectRepositoriesTool } from "./repo-selection.js";
import { registerSetupDbTool } from "./setup-db.js";
import { registerListSourcesTool } from "./list-sources.js";
import { registerListSourceFilesTool } from "./list-source-files.js";
import { registerGetFileTreeTool } from "./get-file-tree.js";
import { registerGetFileTool } from "./get-file.js";
import { registerSearchCodeTool } from "./search-code.js";
import { registerSearchFileTool } from "./search-file.js";

export function registerTools(server: McpServer): void {
  registerLoginTool(server);
  registerRefreshAuthTool(server);
  registerQueryTool(server);
  registerSearchImplementationTool(server);
  registerSuggestionTool(server);
  registerFactCheckTool(server);
  registerSelectRepositoriesTool(server);
  registerSetupDbTool(server);
  registerListSourcesTool(server);
  registerListSourceFilesTool(server);
  registerGetFileTreeTool(server);
  registerGetFileTool(server);
  registerSearchCodeTool(server);
  registerSearchFileTool(server);
}
