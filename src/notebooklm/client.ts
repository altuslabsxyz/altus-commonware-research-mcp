import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NOTEBOOK_ID } from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// NotebookLM MCP Subprocess (notebooklm-mcp from notebooklm-mcp-cli)
// ─────────────────────────────────────────────────────────────────────────────

let client: Client | null = null;
let clientTransport: StdioClientTransport | null = null;

export async function getClient(): Promise<Client> {
  if (client) return client;

  const t = new StdioClientTransport({ command: "notebooklm-mcp", args: [] });
  const c = new Client(
    { name: "altus-tutor-mcp", version: "1.0.0" },
    { capabilities: {} },
  );

  await c.connect(t);
  client = c;
  clientTransport = t;
  return c;
}

/**
 * Ask a question to NotebookLM via the subprocess.
 */
export async function askNotebookLm(question: string): Promise<string> {
  const c = await getClient();

  const result = await c.callTool({
    name: "notebook_query",
    arguments: {
      notebook_id: NOTEBOOK_ID,
      query: question,
    },
  });

  let raw = "";
  if (result.content && Array.isArray(result.content)) {
    const texts = result.content
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text);
    raw = texts.join("\n");
  } else {
    raw = String(result.content ?? "");
  }

  // NotebookLM returns JSON like {"status":"success","answer":"..."}
  // Extract just the answer so the client AI presents it verbatim.
  try {
    const parsed = JSON.parse(raw);
    if (parsed.answer) return parsed.answer;
  } catch { /* not JSON, return raw */ }

  return raw || "No response from NotebookLM.";
}

/**
 * Refresh auth tokens from disk (after user runs `nlm login` separately).
 */
export async function refreshAuth(): Promise<string> {
  const c = await getClient();

  const result = await c.callTool({
    name: "refresh_auth",
    arguments: {},
  });

  if (result.content && Array.isArray(result.content)) {
    const texts = result.content
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text);
    return texts.join("\n");
  }

  return "Auth refreshed.";
}

export async function closeClient(): Promise<void> {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
    client = null;
  }
  if (clientTransport) {
    try { await clientTransport.close(); } catch { /* ignore */ }
    clientTransport = null;
  }
}
