import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isDbInitialized, getFileList, buildFileTree } from "../db/index.js";
import { getTree } from "../github/index.js";

export function registerGetFileTreeTool(server: McpServer): void {
  server.tool(
    "get_file_tree",
    "Get an ASCII directory tree for a repository, optionally scoped to a subdirectory.",
    {
      repo: z.string().describe("Repository identifier (owner/repo)"),
      path: z
        .string()
        .optional()
        .describe("Subdirectory scope (e.g. 'src/')"),
    },
    async ({ repo, path }) => {
      let filePaths: string[];

      if (isDbInitialized()) {
        try {
          filePaths = getFileList(repo, path);
        } catch {
          filePaths = [];
        }
      } else {
        try {
          const tree = await getTree(repo);
          filePaths = tree
            .map((e) => e.path)
            .filter((p) => !path || p.startsWith(path));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text" as const, text: `Error: ${msg}` }],
            isError: true,
          };
        }
      }

      if (filePaths.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No files found for ${repo}${path ? ` under ${path}` : ""}.`,
            },
          ],
        };
      }

      const prefix = path ?? "";
      const tree = buildFileTree(filePaths, prefix);

      let text = `## ${repo}${path ? `/${path}` : ""}\n\n`;
      text += "```\n" + tree + "\n```";

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
