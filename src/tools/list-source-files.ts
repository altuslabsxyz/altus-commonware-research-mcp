import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isDbInitialized, getFileList } from "../db/index.js";
import { getTree } from "../github/index.js";

export function registerListSourceFilesTool(server: McpServer): void {
  server.tool(
    "list_source_files",
    "List files in a repository, optionally filtered by directory prefix.",
    {
      repo: z.string().describe("Repository identifier (owner/repo)"),
      path: z
        .string()
        .optional()
        .describe("Directory prefix filter (e.g. 'src/')"),
    },
    async ({ repo, path }) => {
      let paths: string[];

      if (isDbInitialized()) {
        try {
          paths = getFileList(repo, path);
        } catch {
          paths = [];
        }
      } else {
        try {
          const tree = await getTree(repo);
          paths = tree
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

      if (paths.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No files found for ${repo}${path ? ` under ${path}` : ""}.`,
            },
          ],
        };
      }

      // Group by immediate subdirectory
      const groups = new Map<string, string[]>();
      const prefix = path ?? "";
      for (const p of paths) {
        const relative = p.startsWith(prefix) ? p.slice(prefix.length) : p;
        const parts = relative.split("/");
        const group = parts.length > 1 ? parts[0] : ".";
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group)!.push(p);
      }

      let text = `## Files in ${repo}${path ? `/${path}` : ""} (${paths.length} files)\n\n`;
      for (const [dir, files] of [...groups.entries()].sort()) {
        if (dir !== ".") text += `**${dir}/** (${files.length} files)\n`;
        for (const f of files.sort()) {
          text += `  ${f}\n`;
        }
      }

      return { content: [{ type: "text" as const, text }] };
    }
  );
}
