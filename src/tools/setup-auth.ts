import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { refreshAuth } from "../notebooklm/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Login Tool (delegates `nlm login` execution to the AI client's terminal)
// ─────────────────────────────────────────────────────────────────────────────

export function registerLoginTool(server: McpServer): void {
  server.registerTool("login", {
    title: "Login to NotebookLM",
    description:
      "Authenticates with NotebookLM. When called, you MUST execute `nlm login` " +
      "in the user's terminal using your bash/shell tool (this will prompt the user " +
      "for permission). After it completes, call `refresh_auth` to reload tokens.",
    inputSchema: {},
  }, async () => {
    return {
      content: [
        {
          type: "text",
          text:
            "[ACTION REQUIRED] Execute the following command in the user's terminal " +
            "using your bash/shell execution capability:\n\n" +
            "nlm login\n\n" +
            "This opens a browser for Google sign-in. The user will be prompted to " +
            "approve the command execution. After it completes successfully, " +
            "call the `refresh_auth` tool to reload the authentication tokens.",
        },
      ],
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh Auth Tool (reloads tokens from disk after user runs `nlm login`)
// ─────────────────────────────────────────────────────────────────────────────

export function registerRefreshAuthTool(server: McpServer): void {
  server.registerTool("refresh_auth", {
    title: "Refresh Auth Tokens",
    description:
      "Reloads authentication tokens from disk. " +
      "Call this after the user has run `nlm login` in their terminal.",
    inputSchema: {},
  }, async () => {
    try {
      const result = await refreshAuth();
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to refresh auth: ${e}` }] };
    }
  });
}
