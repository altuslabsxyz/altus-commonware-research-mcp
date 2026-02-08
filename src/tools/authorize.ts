import { randomBytes, createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NOTION_BASE, OAUTH_CALLBACK_URL, OAUTH_TIMEOUT_MS } from "../config.js";
import { b64url, getMcpSessionId } from "../utils/index.js";
import { getSession, pendingOAuth } from "../oauth/index.js";
import { createProtectedState } from "../security.js";

// ─────────────────────────────────────────────────────────────────────────────
// Authorize Notion Tool
// ─────────────────────────────────────────────────────────────────────────────

export function registerAuthorizeTool(server: McpServer): void {
  server.registerTool("authorize_notion", {
    title: "Authorize Notion",
    description: "Connect to Notion (required once per session).",
    inputSchema: {},
  }, async () => {
    const mcpSessionId = getMcpSessionId(server);

    if (getSession(mcpSessionId)) {
      return { content: [{ type: "text", text: "Already connected." }] };
    }

    try {
      // Clean up expired OAuth states
      for (const [state, pending] of pendingOAuth) {
        if (Date.now() - pending.createdAt > OAUTH_TIMEOUT_MS) pendingOAuth.delete(state);
      }

      const redirectUri = OAUTH_CALLBACK_URL;
      const regRes = await fetch(`${NOTION_BASE}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "altus-tutor-mcp",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });

      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);

      const { client_id, client_secret } = (await regRes.json()) as { client_id: string; client_secret?: string };
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      // Use protected state that is cryptographically bound to this MCP session
      const state = createProtectedState(mcpSessionId);

      // Store pending OAuth with MCP session ID for later association
      pendingOAuth.set(state, {
        verifier,
        clientId: client_id,
        clientSecret: client_secret,
        redirectUri,
        createdAt: Date.now(),
        mcpSessionId,
      });

      const authUrl = `${NOTION_BASE}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
      })}`;

      // Try MCP URL elicitation to open browser on CLIENT side
      // Falls back to returning URL directly if client doesn't support elicitation
      try {
        const result = await server.server.elicitInput({
          mode: "url",
          message: "Notion OAuth authorization is required. Please open this URL to authorize.",
          elicitationId: `notion-oauth-${state}`,
          url: authUrl,
        });

        if (result.action === "accept") {
          return { content: [{ type: "text", text: "Authorization URL opened. Please complete the OAuth flow in your browser." }] };
        } else if (result.action === "cancel") {
          pendingOAuth.delete(state);
          return { content: [{ type: "text", text: "Authorization cancelled by user." }] };
        } else {
          return { content: [{ type: "text", text: `Please visit this URL to authorize: ${authUrl}` }] };
        }
      } catch (elicitError) {
        // Client doesn't support URL elicitation - fallback to returning URL directly
        return { content: [{ type: "text", text: `Please open this URL to authorize Notion access:\n\n${authUrl}` }] };
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e}` }] };
    }
  });
}
