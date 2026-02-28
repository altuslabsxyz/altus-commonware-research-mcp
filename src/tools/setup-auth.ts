import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { login, refreshAuth } from "../notebooklm/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Login Tool (launches Chrome for interactive Google sign-in)
// ─────────────────────────────────────────────────────────────────────────────

export function registerLoginTool(server: McpServer): void {
  server.registerTool("login", {
    title: "Login to NotebookLM",
    description:
      "Authenticates with NotebookLM by launching Chrome for Google sign-in. " +
      "A Chrome window will open — the user must complete the Google login. " +
      "Once logged in, auth tokens are saved automatically.",
    inputSchema: {},
  }, async () => {
    try {
      const result = await login();
      return { content: [{ type: "text", text: result }] };
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: `Login failed: ${e instanceof Error ? e.message : e}`,
          },
        ],
      };
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh Auth Tool (reloads tokens from disk)
// ─────────────────────────────────────────────────────────────────────────────

export function registerRefreshAuthTool(server: McpServer): void {
  server.registerTool("refresh_auth", {
    title: "Refresh Auth Tokens",
    description:
      "Reloads authentication tokens from disk. " +
      "Call this after re-authenticating or if queries start failing.",
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
