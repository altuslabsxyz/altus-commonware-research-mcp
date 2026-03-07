import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { REFERENCE_REPOS } from "../config.js";
import { isDbInitialized, getIndexedRepos } from "../db/index.js";

export function registerListSourcesTool(server: McpServer): void {
  server.tool(
    "list_sources",
    "List all configured reference repositories and their indexing status.",
    {},
    async () => {
      const indexed = new Map<string, { file_count: number; indexed_at: string }>();
      if (isDbInitialized()) {
        for (const r of getIndexedRepos()) {
          indexed.set(r.repo, { file_count: r.file_count, indexed_at: r.indexed_at });
        }
      }

      let text = "| Repository | Indexed | Files | Indexed At |\n";
      text += "|---|---|---|---|\n";

      for (const repo of REFERENCE_REPOS) {
        const info = indexed.get(repo);
        if (info) {
          text += `| ${repo} | Yes | ${info.file_count} | ${info.indexed_at} |\n`;
        } else {
          text += `| ${repo} | No | - | - |\n`;
        }
      }

      if (!isDbInitialized()) {
        text += "\n*Database not initialized. Run `setup_db` to index repositories.*";
      }

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
