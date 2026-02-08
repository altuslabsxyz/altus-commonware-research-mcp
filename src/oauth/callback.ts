import { type IncomingMessage, type ServerResponse } from "node:http";
import { NOTION_BASE, MCP_PORT } from "../config.js";
import { htmlResponse } from "../utils/index.js";
import { setSession, pendingOAuth } from "./session.js";

// ─────────────────────────────────────────────────────────────────────────────
// OAuth Callback Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function handleCallback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);

  // Double check pathname if this handler is mounted globally or specifically
  // valid pathnames: /callback
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(htmlResponse("❌", error));
    return;
  }
  if (!state || !pendingOAuth.has(state)) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(htmlResponse("❌", "Expired"));
    return;
  }

  const pending = pendingOAuth.get(state)!;
  pendingOAuth.delete(state);

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/html" }).end(htmlResponse("❌", "No code"));
    return;
  }

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
    });
    if (pending.clientSecret) params.append("client_secret", pending.clientSecret);

    const tokenRes = await fetch(`${NOTION_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!tokenRes.ok) {
      res.writeHead(500, { "Content-Type": "text/html" }).end(htmlResponse("❌", await tokenRes.text()));
      return;
    }

    const data = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    setSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
    });

    res.writeHead(200, { "Content-Type": "text/html" }).end(htmlResponse("✅", "Connected! Close this tab."));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/html" }).end(htmlResponse("❌", String(e)));
  }
}
