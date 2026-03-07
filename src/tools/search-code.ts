import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  isDbInitialized,
  initDb,
  searchFTS,
  buildSnippets,
  selectTopSnippets,
  formatSnippet,
  getLanguage,
  buildFTSQuery,
} from "../db/index.js";

export function registerSearchCodeTool(server: McpServer): void {
  server.tool(
    "search_code",
    "Search indexed code using FTS5 with BM25 ranking. Supports substring (trigram, min 3 chars) and word (prefix) modes. Returns ranked results with code snippets.",
    {
      query: z.string().describe("Search query"),
      mode: z
        .enum(["substring", "word"])
        .optional()
        .describe('Search mode (default: "substring")'),
      repo: z
        .string()
        .optional()
        .describe("Limit to a specific repo (owner/repo)"),
      file_type: z
        .enum(["rs", "ts", "js", "go", "py", "toml", "md", "all"])
        .optional()
        .describe('File type filter (default: "all")'),
      max_results: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (1-50, default: 10)"),
    },
    async ({ query, mode, repo, file_type, max_results }) => {
      if (!isDbInitialized()) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Database not initialized. Run `setup_db` first to index repositories.",
            },
          ],
          isError: true,
        };
      }

      // Ensure DB is open in this process
      initDb();

      const searchMode = mode ?? "substring";
      const limit = max_results ?? 10;
      const fileType = file_type ?? "all";

      const { ftsQuery, snippetMatcher } = buildFTSQuery(query, searchMode);
      if (ftsQuery === null) {
        const minMsg =
          searchMode === "substring"
            ? "Substring search requires at least 3 characters."
            : "No valid search words found.";
        return {
          content: [{ type: "text" as const, text: minMsg }],
          isError: true,
        };
      }

      let results;
      try {
        results = searchFTS({
          query: ftsQuery,
          mode: searchMode,
          repo,
          fileType,
          limit,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Search error: ${msg}` }],
          isError: true,
        };
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results found for "${query}" (mode: ${searchMode}).`,
            },
          ],
        };
      }

      const parts: string[] = [];
      for (const row of results) {
        const lines = row.content.split("\n");
        const lineScores = lines.map((line) =>
          snippetMatcher(line.toLowerCase())
        );
        const snippets = buildSnippets(lineScores);
        const selected = selectTopSnippets(snippets, 5);
        const lang = getLanguage(row.path);

        let section = `### ${row.repo}/${row.path}\n\n`;
        if (selected.length > 0) {
          const formatted = selected.map(({ start, end }) =>
            formatSnippet(lines, start, end)
          );
          section += "```" + lang + "\n" + formatted.join("\n...\n") + "\n```";
        } else {
          section += "*File matched but no specific line snippets extracted.*";
        }
        parts.push(section);
      }

      const text = `## Search Results (${results.length} matches)\n\n${parts.join("\n\n")}`;
      return { content: [{ type: "text" as const, text }] };
    }
  );
}
