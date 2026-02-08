import { getClient, refreshToken, clearSession } from "../oauth/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Notion Client Wrapper
// ─────────────────────────────────────────────────────────────────────────────

let notionClientRef: Awaited<ReturnType<typeof getClient>> = null;

export async function callNotion(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const client = await getClient();
  if (!client) throw new Error("Not connected");

  try {
    const result = await client.callTool({ name: tool, arguments: args });
    return result.content;
  } catch (e) {
    if (String(e).includes("401") || String(e).includes("403")) {
      if (await refreshToken()) {
        notionClientRef = null;
        return callNotion(tool, args);
      }
      clearSession();
    }
    throw e;
  }
}
