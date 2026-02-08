import { getClient, refreshToken, clearSession } from "../oauth/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Notion Client Wrapper (per-session)
// ─────────────────────────────────────────────────────────────────────────────

export async function callNotion(mcpSessionId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const client = await getClient(mcpSessionId);
  if (!client) throw new Error("Not connected");

  try {
    const result = await client.callTool({ name: tool, arguments: args });
    return result.content;
  } catch (e) {
    if (String(e).includes("401") || String(e).includes("403")) {
      if (await refreshToken(mcpSessionId)) {
        return callNotion(mcpSessionId, tool, args);
      }
      clearSession(mcpSessionId);
    }
    throw e;
  }
}
