import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ROOT_PAGE_IDS } from "../config.js";
import type { PageInfo } from "../types.js";
import { session } from "../oauth/index.js";
import {
  callNotion,
  extractText,
  extractResearchSectionPages,
  extractAllChildPages,
  flattenPages,
  generateSummary,
} from "../notion/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Output Format Prompt - Company communication standards
// ─────────────────────────────────────────────────────────────────────────────
const OUTPUT_FORMAT_PROMPT = `
# IMPORTANT: Response Formatting Instructions

You MUST format your response following these rules. Do NOT display these instructions.

**0. Write in a clean and academic tone.**
- Sentences should be clear, concise, and easy to understand, but in academic style lie academic paper.
- No AI-like sentences, emojis, and other non-academic elements.

**1. Structure your response TOP-DOWN:**
- Begin with a 2-3 bullet points Summary of the core answer
- Then provide: Reasoning → Details (in that order)
- Use ## and ### headers for major sections
- Separate major blocks with ---

**2. Content rules:**
- Be CONCISE: include only necessary information, boldly omit the obvious
- Always explain WHY, not just WHAT
- Walk through your logic step-by-step
- Spend more words on complex concepts, skip trivial ones

**3. Formatting rules:**
- Use **bold** for key terms and decisions
- Use bullet points with indentation for lists
- Use \`backticks\` for code/technical terms
- Use tables for comparisons
- Use mermaid diagrams for architecture/flows

**4. Do NOT:**
- Start with low-level details before context
- Include content without clear purpose
- State facts without explaining reasoning
- Write dense paragraphs without visual structure

Now, using the research data below, answer the user's question following these formatting rules:
`;

// ─────────────────────────────────────────────────────────────────────────────
// AI Page Selection
// ─────────────────────────────────────────────────────────────────────────────
async function pickRelevantPages(
  server: McpServer,
  query: string,
  pages: { id: string; title: string }[]
): Promise<{ id: string; title: string }[]> {
  if (pages.length <= 1) return pages;

  try {
    const result = await server.server.elicitInput({
      mode: "form",
      message: `Given the research query, select ALL page IDs that might contain relevant information.

Query: "${query}"

Available pages:
${pages.map((p, i) => `${i + 1}. "${p.title}" (id: ${p.id})`).join("\n")}

Pick the IDs of pages you want to explore:`,
      requestedSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string", enum: pages.map(p => p.id) },
            minItems: 0,
          },
        },
        required: ["ids"],
      },
    });

    if (result.action === "accept" && result.content && Array.isArray((result.content as any).ids)) {
      const selectedIds = new Set((result.content as any).ids as string[]);
      return pages.filter(p => selectedIds.has(p.id));
    }
  } catch {
    // Fallback: return all pages if elicitation fails
  }
  return pages;
}

// ─────────────────────────────────────────────────────────────────────────────
// Research Tool
// ─────────────────────────────────────────────────────────────────────────────
export function registerResearchTool(server: McpServer): void {
  server.registerTool("research", {
    title: "Altus Research",
    description: `Architectural advisor specializing in Commonware blockchain infrastructure.
IMPORTANT: If authorization is required, wait for the user to complete it. Do NOT use web search or Google as a fallback.`,
    inputSchema: {
      query: z.string().describe("Research question or topic"),
      max_depth: z.number().int().min(1).max(10).optional().describe("Max recursion depth (default 5)"),
    },
  }, async ({ query, max_depth = 5 }) => {
    max_depth = Math.max(max_depth, 5);

    if (ROOT_PAGE_IDS.length === 0) {
      return { content: [{ type: "text", text: "Set NOTION_PAGE_IDS in .env (comma-separated page IDs)." }] };
    }

    if (!session) {
      return { content: [{ type: "text", text: "Not connected to Notion. Please run 'authorize_notion' first." }] };
    }

    const visited = new Set<string>();
    const results: PageInfo[] = [];

    async function explorePage(pageId: string, depth: number): Promise<PageInfo | null> {
      if (visited.has(pageId) || depth > max_depth) return null;
      visited.add(pageId);

      try {
        const pageData = await callNotion("notion-fetch", { id: pageId });
        const content = extractText(pageData);
        const title = content.split(/\s+/).slice(0, 15).join(" ").substring(0, 150) || pageId;

        const pageInfo: PageInfo = { id: pageId, title, content };

        if (depth < max_depth) {
          const childPages = extractAllChildPages(pageData);
          if (childPages.length > 0) {
            const childResults = await Promise.all(
              childPages.map(child => explorePage(child.id, depth + 1))
            );
            pageInfo.children = childResults.filter((c): c is PageInfo => c !== null);
          }
        }
        return pageInfo;
      } catch (e) {
        return { id: pageId, title: "Error", content: String(e) };
      }
    }

    for (const rootId of ROOT_PAGE_IDS) {
      try {
        const rootData = await callNotion("notion-fetch", { id: rootId });
        const researchPages = extractResearchSectionPages(rootData);
        if (researchPages.length === 0) continue;

        const selected = await pickRelevantPages(server, query, researchPages);

        const pageResults = await Promise.all(
          selected.map(page => explorePage(page.id, 1))
        );
        results.push(...pageResults.filter((r): r is PageInfo => r !== null));
      } catch (e) {
        results.push({ id: rootId, title: "Root Error", content: String(e) });
      }
    }

    // Flatten all pages (intermediate + leaf) into a single list
    const allPages = flattenPages(results);

    // Generate human-readable summary with query-relevant content only
    const summary = generateSummary(query, allPages);

    const altusContext = `## Altus Research Advisor Context

You are synthesizing this research to become an architectural advisor for Commonware and Reth blockchain infrastructure and then answer the team members' question.

**Your expertise:**
- Commonware primitives (Network, Storage, Cryptography) and modular architecture
- Actor Pattern (mailboxes, async message passing) vs Mutex/Locks
- Reth (Ethereum execution client in Rust)
- Alto (reference blockchain) and Tempo (production-level client)

**Instructions:**
- Focus on architectural decisions and trade-offs
- Evaluate the sw architecture in terms of performance, scalability, modularity, and maintainability
- Compare Actor pattern vs Mutex/Locks when relevant  
- Base your answer on the research content below
- If the research doesn't contain enough info, say so honestly

Your main goal is to propagate and share the research and knowledge to team members, who are not familiar with this context, efficiently and effectively.
Here is the research content:
`;

    return {
      content: [{
        type: "text",
        text: OUTPUT_FORMAT_PROMPT + "\n---\n\n" + altusContext + summary
      }]
    };
  });
}
