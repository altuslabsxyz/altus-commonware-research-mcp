import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  isDbInitialized,
  getFile,
  isValidPath,
  formatWithLineNumbers,
  getLanguage,
} from "../db/index.js";
import { fetchRawFile } from "../github/index.js";

export function registerGetFileTool(server: McpServer): void {
  server.tool(
    "get_file",
    "Get the content of a file from a repository, with optional line range.",
    {
      repo: z.string().describe("Repository identifier (owner/repo)"),
      path: z.string().describe("File path relative to repo root"),
      start_line: z
        .number()
        .optional()
        .describe("0-indexed start line (inclusive)"),
      end_line: z
        .number()
        .optional()
        .describe("0-indexed end line (inclusive)"),
    },
    async ({ repo, path, start_line, end_line }) => {
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

      const formatted = formatWithLineNumbers(content, start_line, end_line);
      const lang = getLanguage(path);

      let text = `## ${path}\n\n`;
      text += "```" + lang + "\n" + formatted + "\n```";

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
