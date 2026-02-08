import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NOTION_BASE, TOKEN_REFRESH_BUFFER_MS } from "../config.js";
import type { Session, OAuthPending } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Session State
// ─────────────────────────────────────────────────────────────────────────────
export let session: Session | null = null;
export let notionClient: Client | null = null;
export const pendingOAuth = new Map<string, OAuthPending>();

// ─────────────────────────────────────────────────────────────────────────────
// Session Management
// ─────────────────────────────────────────────────────────────────────────────
export function setSession(newSession: Session | null): void {
  session = newSession;
}

export function clearSession(): void {
  session = null;
  notionClient?.close().catch(() => { });
  notionClient = null;
}

export async function refreshToken(): Promise<boolean> {
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
      if (res.status === 400 || res.status === 401) clearSession();
      return false;
    }

    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    session = {
      ...session,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? session.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    };
    notionClient?.close().catch(() => { });
    notionClient = null;
    return true;
  } catch {
    return false;
  }
}

export async function getClient(): Promise<Client | null> {
  if (!session) return null;
  if (session.expiresAt && session.expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS) {
    await refreshToken();
  }
  if (!session) return null;

  if (!notionClient) {
    const client = new Client({ name: "altus-tutor-mcp", version: "1.0.0" }, { capabilities: {} });
    const authHeader = { Authorization: `Bearer ${session.accessToken}` };

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${NOTION_BASE}/mcp`), { requestInit: { headers: authHeader } }));
      notionClient = client;
    } catch {
      return null;
    }
  }
  return notionClient;
}
