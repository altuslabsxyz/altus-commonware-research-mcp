import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ─────────────────────────────────────────────────────────────────────────────
// MCP Session ID Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the MCP session ID from the server's transport.
 * Falls back to a random ID if transport doesn't expose session ID.
 */
export function getMcpSessionId(server: McpServer): string {
  // Access the underlying transport's session ID
  // The server.server is the Protocol instance, which has a transport with sessionId
  const transport = (server.server as any)._transport;
  if (transport?.sessionId) {
    return transport.sessionId;
  }

  // Fallback: use a hash of the server instance
  // This shouldn't happen in normal operation but provides a safety net
  console.error("Warning: Could not get MCP session ID from transport, using fallback");
  return `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
