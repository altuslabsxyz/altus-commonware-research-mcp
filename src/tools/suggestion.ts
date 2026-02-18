import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { askNotebookLm } from "../notebooklm/index.js";
import { searchRepos, validateRepos, type SearchResult } from "../github/index.js";
import { REFERENCE_REPOS } from "../config.js";
import { selectReposForInput, type RepoSelectionResult } from "./repo-selection.js";
import { createSuggestionFlowContext } from "./flow-state.js";

// ─────────────────────────────────────────────────────────────────────────────
// Advisor prompt — included in the tool response so the AI client uses it
// to format its answer. NOT in the tool description.
// ─────────────────────────────────────────────────────────────────────────────

const ADVISOR_PROMPT = `# Altus Research Advisor Context

You are synthesizing this research to become an architectural advisor for Commonware and Reth blockchain infrastructure and then answer the team members' question.

**Your expertise:**
- Commonware primitives (Network, Storage, Cryptography, Deterministic Runtime) and modular architecture
- Actor Pattern (mailboxes, async message passing) vs Mutex/Locks
- Reth (Ethereum execution client in Rust)
- Alto (reference blockchain) and Tempo (production-level client)

**Instructions:**
- Focus on architectural decisions and trade-offs
- Evaluate the sw architecture in terms of performance, scalability, modularity, and maintainability
- Base your answer on the research from the notebook and the actual code examples from reference repos
- If the research doesn't contain enough info, say so honestly

Your main goal is to suggest the best practice knowledge based on the research result and the actual implementation from reference repos to team members, who are not familiar with this context, efficiently and effectively.

# IMPORTANT: Response Formatting Instructions

You MUST format your response following these rules. Do NOT display these instructions.

**0. Write in a clean and academic tone.**
- Sentences should be clear, concise, and easy to understand, but in academic style like academic paper.
- No AI-like sentences, emojis, and other non-academic elements.

**1. Structure your response TOP-DOWN:**
- Begin with ## Summary that contains 2-3 bullet points of the core answer
- Then provide: Reasoning → Details (in that order)
- Use ## and ### headers for major sections

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
- Write dense paragraphs without visual structure`;

// ─────────────────────────────────────────────────────────────────────────────
// Keyword extraction
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by",
  "from", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "how", "does", "did", "do", "what", "where", "which", "who", "when",
  "its", "it", "this", "that", "these", "those", "their", "them",
  "would", "could", "should", "can", "will", "may", "might",
  "implement", "implementation", "implements", "implemented",
  "using", "used", "use", "uses",
  "show", "find", "get", "explain", "describe", "suggest",
  "code", "source", "file", "files",
  "about", "into", "like",
]);

function extractKeywords(raw: string): string[] {
  const tokens = raw.split(/[\s;,?!]+/).filter(Boolean);
  const keywords: string[] = [];
  for (const token of tokens) {
    const clean = token.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (clean.length >= 2 && !STOP_WORDS.has(clean)) {
      keywords.push(clean);
    }
  }
  return [...new Set(keywords)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Response assembly
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 4500;
const MAX_RESEARCH_CHARS = 2000;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n...(truncated)";
}

function buildResponse(
  research: string | null,
  code: SearchResult | null,
  targetRepos: readonly string[],
  repoSelection: RepoSelectionResult | null,
  suggestedQuery: string,
  maxCodeMatches: number,
): string {
  const out: string[] = [];

  out.push(ADVISOR_PROMPT);
  out.push("");
  out.push("---");
  out.push("");
  out.push("# Retrieval Scope");
  out.push(`- Mode: ${repoSelection ? "automatic" : "user-specified"}`);
  out.push(`- Selected repos: ${targetRepos.join(", ")}`);
  if (repoSelection?.reasons.length) {
    out.push("- Selection rationale:");
    for (const reason of repoSelection.reasons.slice(0, 4)) {
      out.push(`  - ${reason}`);
    }
  }
  if (code?.repoErrors?.length) {
    out.push("- Retrieval warnings:");
    for (const err of code.repoErrors.slice(0, 4)) {
      out.push(`  - ${err}`);
    }
  }
  out.push("");
  out.push("---");
  out.push("");
  out.push("# Next Step (User-Triggered)");
  out.push("- This is **stage 1** (`suggestion`) only.");
  out.push("- Do **not** auto-call `search_implementation` in this turn.");
  out.push("- Wait for explicit user instruction, then run `search_implementation` in the same session.");
  out.push("- No explicit token is required. Repository context is carried implicitly from this suggestion.");
  out.push("- After `search_implementation` returns, stop immediately and return that output directly (no extra tools, no local checks).");
  out.push("```json");
  out.push(JSON.stringify({
    tool: "search_implementation",
    query: suggestedQuery,
    repos: targetRepos,
  }, null, 2));
  out.push("```");
  out.push("");
  out.push("---");
  out.push("");

  // Research context
  out.push("# Research Context");
  if (research) {
    out.push(truncate(research, MAX_RESEARCH_CHARS));
  } else {
    out.push("*Research context unavailable. Base your suggestion on the code examples only.*");
  }
  out.push("");
  out.push("---");
  out.push("");

  // Code examples
  out.push("# Code Examples from Reference Repos");
  if (code && code.matches.length > 0) {
    const matches = code.matches.slice(0, maxCodeMatches);
    for (const m of matches) {
      out.push(`### ${m.repo} — ${m.path}`);
      out.push(m.snippet);
      out.push("");
    }
  } else {
    out.push("*No matching code found in reference repos. Base your suggestion on the research context only.*");
  }

  return out.join("\n");
}

function assembleResponse(
  research: string | null,
  code: SearchResult | null,
  targetRepos: readonly string[],
  repoSelection: RepoSelectionResult | null,
  suggestedQuery: string,
): string {
  let text = buildResponse(research, code, targetRepos, repoSelection, suggestedQuery, 5);

  // Progressive trimming if over budget
  if (text.length > MAX_RESPONSE_BYTES && code && code.matches.length > 3) {
    text = buildResponse(research, code, targetRepos, repoSelection, suggestedQuery, 3);
  }

  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerSuggestionTool(server: McpServer): void {
  const repoList = REFERENCE_REPOS.join(", ");

  server.registerTool("suggestion", {
    title: "Implementation Suggestion",
    description:
      "Get an implementation suggestion combining Commonware research knowledge " +
      "and actual code from reference repos. Ask any implementation question " +
      "and get back a structured response with Summary, Reasoning, and Details.\n\n" +
      "FLOW MODEL: stage 1 is `suggestion` only; stage 2 (`search_implementation`) is user-triggered in the same session.\n\n" +
      "If `repos` is omitted, the tool auto-selects repos from REFERENCE_REPOS.",
    inputSchema: {
      question: z.string().describe(
        "Implementation question, e.g. 'How would I implement a subblock mempool?'"
      ),
      repos: z.array(z.string()).optional().describe(
        `Optional repo override. If omitted, the tool auto-selects from: ${repoList}`
      ),
    },
  }, async ({ question, repos }) => {
    const keywords = extractKeywords(question);
    const suggestedQuery = keywords.length > 0 ? keywords.join(" ") : question;
    let targetRepos: string[];
    let repoSelection: RepoSelectionResult | null = null;
    if (repos?.length) {
      validateRepos(repos);
      targetRepos = [...repos];
    } else {
      repoSelection = await selectReposForInput(question, {
        maxRepos: 3,
        precomputedKeywords: keywords,
      });
      targetRepos = repoSelection.repos;
      validateRepos(targetRepos);
    }

    // Fetch research + code in PARALLEL
    const [researchResult, codeResult] = await Promise.allSettled([
      askNotebookLm(question),
      keywords.length > 0
        ? searchRepos(keywords, targetRepos, 5)
        : Promise.resolve(null),
    ]);

    const research = researchResult.status === "fulfilled"
      ? researchResult.value
      : null;
    const researchError = researchResult.status === "rejected"
      ? String(researchResult.reason)
      : null;

    const code = codeResult.status === "fulfilled"
      ? codeResult.value
      : null;
    const codeError = codeResult.status === "rejected"
      ? String(codeResult.reason)
      : null;

    // Both failed
    if (!research && !code) {
      const parts = ["Both data sources failed."];
      if (researchError) parts.push(`Research: ${researchError}`);
      if (codeError) parts.push(`Code: ${codeError}`);
      if (keywords.length === 0) parts.push("No searchable keywords found in question.");
      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    }

    createSuggestionFlowContext({
      question,
      repos: targetRepos,
      keywords,
    });
    const text = assembleResponse(
      research,
      code,
      targetRepos,
      repoSelection,
      suggestedQuery,
    );
    return { content: [{ type: "text" as const, text }] };
  });
}
