import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { askNotebookLm } from "../notebooklm/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Query Tool (proxies to notebooklm-mcp-cli notebook_query)
// ─────────────────────────────────────────────────────────────────────────────

export function registerQueryTool(server: McpServer): void {
  server.registerTool("query", {
    title: "Query Research",
    description: "Ask a question about Commonware research via NotebookLM. Run `nlm login` first if not authenticated. Present the response exactly as received — do not reformat, summarize, or restructure it.",
    inputSchema: {
      question: z.string().describe("The research question to ask NotebookLM"),
    },
  }, async ({ question }) => {
    try {
      const answer = await askNotebookLm(question);
      return { content: [{ type: "text", text: answer }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error querying NotebookLM: ${e}` }] };
    }
  });
}
