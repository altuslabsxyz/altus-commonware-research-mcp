import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NOTION_BASE, TOKEN_REFRESH_BUFFER_MS } from "../config.js";
import type { Session, OAuthPending } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-Session State (keyed by MCP session ID)
// ─────────────────────────────────────────────────────────────────────────────
const sessions = new Map<string, Session>();
const notionClients = new Map<string, Client>();

// Pending OAuth - keyed by OAuth state parameter, includes MCP session ID
export const pendingOAuth = new Map<string, OAuthPending & { mcpSessionId: string }>();

// ─────────────────────────────────────────────────────────────────────────────
// Session Management (per MCP session)
// ─────────────────────────────────────────────────────────────────────────────
export function getSession(mcpSessionId: string): Session | null {
  return sessions.get(mcpSessionId) ?? null;
}

export function setSession(mcpSessionId: string, session: Session): void {
  sessions.set(mcpSessionId, session);
}

export function clearSession(mcpSessionId: string): void {
  sessions.delete(mcpSessionId);
  const client = notionClients.get(mcpSessionId);
  if (client) {
    client.close().catch(() => { });
    notionClients.delete(mcpSessionId);
  }
}

export async function refreshToken(mcpSessionId: string): Promise<boolean> {
  const session = sessions.get(mcpSessionId);
  if (!session?.refreshToken) return false;

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
  });
  if (session.clientSecret) params.append("client_secret", session.clientSecret);

  try {
    const res = await fetch(`${NOTION_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!res.ok) {
      if (res.status === 400 || res.status === 401) clearSession(mcpSessionId);
      return false;
    }

    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    sessions.set(mcpSessionId, {
      ...session,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? session.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    });

    // Clear old client so it gets recreated with new token
    const client = notionClients.get(mcpSessionId);
    if (client) {
      client.close().catch(() => { });
      notionClients.delete(mcpSessionId);
    }
    return true;
  } catch {
    return false;
  }
}

export async function getClient(mcpSessionId: string): Promise<Client | null> {
  const session = sessions.get(mcpSessionId);
  if (!session) return null;

  if (session.expiresAt && session.expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS) {
    await refreshToken(mcpSessionId);
  }

  const updatedSession = sessions.get(mcpSessionId);
  if (!updatedSession) return null;

  let client = notionClients.get(mcpSessionId);
  if (!client) {
    client = new Client({ name: "altus-tutor-mcp", version: "1.0.0" }, { capabilities: {} });
    const authHeader = { Authorization: `Bearer ${updatedSession.accessToken}` };

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${NOTION_BASE}/mcp`), { requestInit: { headers: authHeader } }));
      notionClients.set(mcpSessionId, client);
    } catch {
      return null;
    }
  }
  return client;
}
