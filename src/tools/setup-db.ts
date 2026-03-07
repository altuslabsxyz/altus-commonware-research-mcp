import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { REFERENCE_REPOS } from "../config.js";
import { indexRepos } from "../db/indexer.js";

export function registerSetupDbTool(server: McpServer): void {
  server.tool(
    "setup_db",
    "Initialize the local SQLite FTS5 index and index repositories. Fetches file trees and content from GitHub, stores in local DB for fast search.",
    {
      repos: z
        .array(z.string())
        .optional()
        .describe("Subset of REFERENCE_REPOS to index (default: all)"),
      force: z
        .boolean()
        .optional()
        .describe("Re-index even if already indexed (default: false)"),
    },
    async ({ repos, force }) => {
      const targetRepos = repos ?? [...REFERENCE_REPOS];
      const result = await indexRepos(targetRepos, { force: force ?? false });

      let text = `## Index Summary (${result.elapsedSeconds.toFixed(1)}s)\n\n`;
      text += result.summary.join("\n");
      if (result.errors.length > 0) {
        text += `\n\n## Errors\n\n${result.errors.join("\n")}`;
      }

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
