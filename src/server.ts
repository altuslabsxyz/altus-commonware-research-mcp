import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_PORT } from "./config.js";
import { parseBody } from "./utils/index.js";
import { handleCallback } from "./oauth/index.js";
import {
  generateSessionSecret,
  setSessionSecret,
  validateSessionSecret,
  clearSessionSecret,
} from "./security.js";

// ─────────────────────────────────────────────────────────────────────────────
// Session State (transport + server per session)
// ─────────────────────────────────────────────────────────────────────────────
interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

const sessions = new Map<string, Session>();

export function getTransports() {
  return new Map([...sessions].map(([k, v]) => [k, v.transport]));
}

// Factory function type for creating new MCP server instances
export type McpServerFactory = () => McpServer;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server with Streamable HTTP Transport
// ─────────────────────────────────────────────────────────────────────────────
export function createHttpServer(createMcpServer: McpServerFactory) {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, x-session-secret");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, x-session-secret");

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const sessionSecret = req.headers["x-session-secret"] as string | undefined;

      // Reuse existing session - REQUIRES valid session secret
      if (sessionId && sessions.has(sessionId)) {
        if (!validateSessionSecret(sessionId, sessionSecret)) {
          res.writeHead(401, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "Invalid or missing session secret" })
          );
          return;
        }
        const session = sessions.get(sessionId)!;
        const body = await parseBody(req);
        await session.transport.handleRequest(req, res, body);
        return;
      }

      // New session - create transport AND new McpServer instance
      if (req.method === "POST" || req.method === "GET") {
        // Generate session secret for new session
        const newSessionSecret = generateSessionSecret();

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, server: mcpServer });
            // Store the session secret
            setSessionSecret(sid, newSessionSecret);
            // Return the secret to the client (only on initial connection)
            res.setHeader("x-session-secret", newSessionSecret);
          },
        });

        // Create a NEW McpServer instance for this session
        const mcpServer = createMcpServer();

        transport.onclose = () => {
          if (transport.sessionId) {
            const session = sessions.get(transport.sessionId);
            if (session) {
              session.server.close().catch(() => { });
            }
            sessions.delete(transport.sessionId);
            // Clear the session secret
            clearSessionSecret(transport.sessionId);
          }
        };

        await mcpServer.connect(transport);
        const body = await parseBody(req);
        await transport.handleRequest(req, res, body);
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid request" }));
      return;
    }

    // OAuth callback
    if (url.pathname === "/callback") {
      await handleCallback(req, res);
      return;
    }

    // Health check (no session count to avoid information leakage)
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok" }));
      return;
    }

    res.writeHead(404).end();
  });

  return httpServer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────
export async function shutdown(httpServer: ReturnType<typeof createServer>): Promise<void> {
  console.error("Shutting down...");
  for (const [, session] of sessions) {
    await session.transport.close().catch(() => { });
    await session.server.close().catch(() => { });
  }
  sessions.clear();
  httpServer.close();
}
