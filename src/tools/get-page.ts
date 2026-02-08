import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSession } from "../oauth/index.js";
import { getMcpSessionId } from "../utils/index.js";
import { callNotion } from "../notion/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Get Page Tool
// ─────────────────────────────────────────────────────────────────────────────

export function registerGetPageTool(server: McpServer): void {
  server.registerTool("get_page", {
    title: "Get Specific Page",
    description: "Fetch a specific Notion page by ID.",
    inputSchema: {
      page_id: z.string().describe("Notion page ID"),
    },
  }, async ({ page_id }) => {
    const mcpSessionId = getMcpSessionId(server);

    if (!getSession(mcpSessionId)) {
      return { content: [{ type: "text", text: "Not connected. Use 'authorize_notion' first." }] };
    }

    try {
      const page = await callNotion(mcpSessionId, "notion-fetch", { id: page_id });
      return { content: [{ type: "text", text: JSON.stringify({ page }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e}` }] };
    }
  });
}
