import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isDbInitialized, initDb, getFile, isValidPath, getLanguage } from "../db/index.js";
import { fetchRawFile } from "../github/index.js";

export function registerSearchFileTool(server: McpServer): void {
  server.tool(
    "search_file",
    "Search within a specific file for a pattern (case-insensitive substring match) and return matching lines with context.",
    {
      repo: z.string().describe("Repository identifier (owner/repo)"),
      path: z.string().describe("File path relative to repo root"),
      pattern: z.string().describe("Search pattern (case-insensitive substring)"),
      context_lines: z
        .number()
        .min(0)
        .max(20)
        .optional()
        .describe("Lines of context around matches (0-20, default: 3)"),
    },
    async ({ repo, path, pattern, context_lines }) => {
      if (!isValidPath(path)) {
        return {
          content: [
            { type: "text" as const, text: "Error: Invalid path (no .. or absolute paths)." },
          ],
          isError: true,
        };
      }

      let content: string | null = null;

      if (isDbInitialized()) {
        initDb();
        const row = getFile(repo, path);
        if (row) content = row.content;
      }

      if (content === null) {
        content = await fetchRawFile(repo, path);
      }

      if (content === null) {
        return {
          content: [
            { type: "text" as const, text: `File not found: ${repo}/${path}` },
          ],
          isError: true,
        };
      }

      const ctx = context_lines ?? 3;
      const lines = content.split("\n");
      const patternLower = pattern.toLowerCase();

      // Find matching line indices
      const matchIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(patternLower)) {
          matchIndices.push(i);
        }
      }

      if (matchIndices.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No matches for "${pattern}" in ${repo}/${path}.`,
            },
          ],
        };
      }

      // Build context windows and merge overlapping
      const windows: Array<{ start: number; end: number }> = [];
      for (const idx of matchIndices) {
        const start = Math.max(0, idx - ctx);
        const end = Math.min(lines.length - 1, idx + ctx);

        if (windows.length > 0 && start <= windows[windows.length - 1].end + 1) {
          windows[windows.length - 1].end = end;
        } else {
          windows.push({ start, end });
        }
      }

      const lang = getLanguage(path);
      const parts: string[] = [];
      for (const w of windows) {
        const snippet = lines
          .slice(w.start, w.end + 1)
          .map((l, i) => `${w.start + i}: ${l}`)
          .join("\n");
        parts.push(snippet);
      }

      let text = `## Matches for "${pattern}" in ${path} (${matchIndices.length} matches)\n\n`;
      text += "```" + lang + "\n" + parts.join("\n...\n") + "\n```";

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
