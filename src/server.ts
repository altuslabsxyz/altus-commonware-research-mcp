import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_PORT } from "./config.js";
import { parseBody } from "./utils/index.js";
import { handleCallback } from "./oauth/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Transport State
// ─────────────────────────────────────────────────────────────────────────────
const transports = new Map<string, StreamableHTTPServerTransport>();

export function getTransports() {
  return transports;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server with Streamable HTTP Transport
// ─────────────────────────────────────────────────────────────────────────────
export function createHttpServer(mcpServer: McpServer) {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${MCP_PORT}`);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      // Reuse existing transport for session
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        const body = await parseBody(req);
        await transport.handleRequest(req, res, body);
        return;
      }

      // New session - create transport
      if (req.method === "POST" || req.method === "GET") {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
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

    // Health check
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok", sessions: transports.size }));
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
  for (const [, transport] of transports) {
    await transport.close().catch(() => { });
  }
  transports.clear();
  httpServer.close();
}
