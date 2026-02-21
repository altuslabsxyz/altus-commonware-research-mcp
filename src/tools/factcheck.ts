import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchRepos,
  fetchRawFile,
  fetchRepoContext,
  getTree,
  validateRepos,
  inferLanguage,
  type TreeEntry,
} from "../github/index.js";
import { REFERENCE_REPOS } from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TREE_PATHS = 800;
const MAX_ITEMS = 20;
const MAX_CONCURRENCY = 3;
const MAX_SEARCH_MATCHES_PER_ITEM = 4;
const MAX_FILE_CHARS = 12000;
const MAX_SNIPPET_CHARS = 1800;
const MAX_FILE_PATHS_PER_ITEM = 6;

// Source file extensions to include in the tree listing for the client AI.
const SOURCE_EXTENSIONS = new Set([
  ".rs", ".toml", ".ts", ".js", ".go", ".py", ".sol", ".md",
  ".json", ".yaml", ".yml", ".lock",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n...(truncated)`;
}

function filterTree(entries: readonly TreeEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    const dotIdx = entry.path.lastIndexOf(".");
    if (dotIdx < 0) continue;
    const ext = entry.path.slice(dotIdx);
    if (SOURCE_EXTENSIONS.has(ext)) {
      paths.push(entry.path);
    }
    if (paths.length >= MAX_TREE_PATHS) break;
  }
  return paths;
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning prompt — embedded in tool response for client AI
// ─────────────────────────────────────────────────────────────────────────────

function buildPlanningResponse(
  document: string,
  repos: readonly string[],
  repoSections: string[],
): string {
  const out: string[] = [];

  out.push("# Fact-Check Planning");
  out.push("");
  out.push("You have been given a document and reference repositories.");
  out.push("Your task is to analyze the document, extract items that can be validated against source code, and then call `factcheck_validate` to retrieve actual code evidence.");
  out.push("");
  out.push("## CRITICAL CONSTRAINTS");
  out.push("");
  out.push("- **DO NOT** call `query`, `suggestion`, or any other tool that queries NotebookLM.");
  out.push("- **DO NOT** search the internet, use web search, or fetch external URLs.");
  out.push("- **ONLY** use `factcheck_validate` as your next tool call.");
  out.push("- All evidence must come exclusively from the reference repository source code retrieved by `factcheck_validate`.");
  out.push("");
  out.push("## Instructions");
  out.push("");
  out.push("1. Read the document below carefully.");
  out.push("2. Identify **specific technical claims** that can be verified by inspecting source code. Focus on:");
  out.push("   - Statements about what code does or does not do");
  out.push("   - Logic flows, call chains, execution sequences");
  out.push("   - Component roles, struct/function existence and behavior");
  out.push("   - Configuration defaults, data structures, type relationships");
  out.push("   - Trust assumptions (what is trusted vs rebuilt/verified)");
  out.push("3. For each item, determine:");
  out.push("   - `text`: The exact claim to validate");
  out.push("   - `repo`: Which repository to search (from the list below)");
  out.push("   - `file_paths`: **(PREFERRED)** Specific file paths to fetch from the repo tree below. This is fast — direct file download, no search overhead.");
  out.push("   - `keywords`: **(FALLBACK ONLY)** Use only when you cannot determine file paths. Keyword search is significantly slower (triggers GitHub API search + multiple file fetches).");
  out.push("4. Skip claims that **cannot** be verified from code:");
  out.push("   - Performance benchmarks / timing claims");
  out.push("   - Design philosophy opinions");
  out.push("   - Future plans or speculative statements");
  out.push("   - Claims about external dependencies (e.g., MDBX internals) unless the wrapping code is in the repo");
  out.push("");
  out.push("## How to call the next tool");
  out.push("");
  out.push("After extracting items, call `factcheck_validate` with:");
  out.push("```json");
  out.push(JSON.stringify({
    document: "<the original document text (or a condensed version)>",
    items: [
      {
        text: "<claim to validate>",
        repo: "<owner/repo>",
        keywords: ["<search term 1>", "<search term 2>"],
        file_paths: ["<optional/path/to/file.rs>"],
      },
    ],
  }, null, 2));
  out.push("```");
  out.push("");

  out.push("---");
  out.push("");

  out.push("## Available Repositories");
  out.push("");
  out.push(`Repositories: ${repos.join(", ")}`);
  out.push("");

  for (const section of repoSections) {
    out.push(section);
    out.push("");
  }

  out.push("---");
  out.push("");

  out.push("## Document to Fact-Check");
  out.push("");
  out.push(document);

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation response — embedded in tool response for client AI
// ─────────────────────────────────────────────────────────────────────────────

interface ItemEvidence {
  text: string;
  repo: string;
  searchedKeywords: string[];
  fetchedPaths: string[];
  codeSnippets: Array<{ path: string; language: string; snippet: string }>;
  flowChains: string[];
  errors: string[];
}

function buildValidationResponse(
  document: string,
  evidence: readonly ItemEvidence[],
): string {
  const out: string[] = [];

  out.push("# Fact-Check Validation");
  out.push("");
  out.push("Below is each claim paired with the code evidence retrieved from the repository.");
  out.push("Your task: validate each claim against its evidence and produce a final verdict.");
  out.push("");
  out.push("## CRITICAL CONSTRAINTS");
  out.push("");
  out.push("- **DO NOT** call `query`, `suggestion`, or any other tool that queries NotebookLM.");
  out.push("- **DO NOT** search the internet, use web search, or fetch external URLs.");
  out.push("- Base your verdicts **exclusively** on the code evidence provided below.");
  out.push("- If the evidence is insufficient, verdict is NOT_VERIFIED — do not attempt to fill gaps from external sources.");
  out.push("");
  out.push("## Instructions");
  out.push("");
  out.push("For each item:");
  out.push("1. Read the claim and the retrieved code evidence carefully.");
  out.push("2. Determine a **validity level**:");
  out.push("   - **VERIFIED**: Code directly and unambiguously confirms the claim.");
  out.push("   - **PARTIALLY_VERIFIED**: Code partially supports the claim, but some aspects are unconfirmed or ambiguous.");
  out.push("   - **NOT_VERIFIED**: No relevant evidence was found. Cannot confirm or deny.");
  out.push("   - **CONTRADICTED**: Code directly contradicts what the claim states.");
  out.push("   - **UNVERIFIABLE**: The claim requires information beyond what code inspection can provide (runtime behavior, performance, etc.).");
  out.push("3. Provide a concise **reason** citing the specific code evidence (file path, function name, line) that supports your verdict.");
  out.push("4. If the claim is wrong or misleading, explain **what the code actually does**.");
  out.push("");
  out.push("## Output Format");
  out.push("");
  out.push("Present your findings as a structured report with:");
  out.push("1. A summary table (item #, claim excerpt, verdict, confidence)");
  out.push("2. Detailed per-item analysis with evidence citations");
  out.push("3. A final section listing corrections needed (if any)");
  out.push("");
  out.push("---");
  out.push("");

  for (let i = 0; i < evidence.length; i++) {
    const item = evidence[i];
    out.push(`## Item ${i + 1}: ${item.repo}`);
    out.push("");
    out.push(`**Claim:** ${item.text}`);
    out.push("");

    if (item.errors.length > 0) {
      out.push("**Retrieval warnings:**");
      for (const err of item.errors) {
        out.push(`- ${err}`);
      }
      out.push("");
    }

    if (item.codeSnippets.length > 0) {
      out.push("**Code evidence:**");
      out.push("");
      for (const snippet of item.codeSnippets) {
        out.push(`### ${snippet.path}`);
        out.push(snippet.snippet);
        out.push("");
      }
    } else {
      out.push("**Code evidence:** No matching code found.");
      out.push("");
    }

    if (item.flowChains.length > 0) {
      out.push("**Call-chain evidence:**");
      for (const chain of item.flowChains) {
        out.push(`- ${chain}`);
      }
      out.push("");
    }

    if (item.fetchedPaths.length > 0 && item.codeSnippets.length === 0) {
      out.push(`**Fetched files (no match):** ${item.fetchedPaths.join(", ")}`);
      out.push("");
    }

    out.push("---");
    out.push("");
  }

  if (document) {
    out.push("## Original Document (for reference)");
    out.push("");
    out.push(truncate(document, 6000));
  }

  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence retrieval per item
// ─────────────────────────────────────────────────────────────────────────────

interface ValidationItemInput {
  text: string;
  repo: string;
  keywords?: string[];
  file_paths?: string[];
}

async function retrieveEvidence(item: ValidationItemInput): Promise<ItemEvidence> {
  const keywords = (item.keywords ?? []).map(k => k.trim()).filter(Boolean);
  const filePaths = (item.file_paths ?? []).map(p => p.trim()).filter(Boolean).slice(0, MAX_FILE_PATHS_PER_ITEM);
  const errors: string[] = [];
  const codeSnippets: ItemEvidence["codeSnippets"] = [];
  const flowChains: string[] = [];
  const fetchedPaths: string[] = [];

  // Strategy 1: Direct file fetch — fast, no search overhead.
  // Preferred when the client AI specifies exact paths from the repo tree.
  if (filePaths.length > 0) {
    const fetches = filePaths.map(async (path) => {
      try {
        const content = await fetchRawFile(item.repo, path);
        fetchedPaths.push(path);
        if (content) {
          const lang = inferLanguage(path);
          codeSnippets.push({
            path: `${item.repo}/${path}`,
            language: lang,
            snippet: truncate(content, MAX_FILE_CHARS),
          });
        }
      } catch {
        errors.push(`Failed to fetch ${path}`);
      }
    });
    await Promise.all(fetches);
  }

  // Strategy 2: Keyword search — only when no file_paths are given.
  // searchRepos is expensive (Code Search API + up to 25 raw file fetches),
  // so we skip it when direct paths already provide evidence.
  if (filePaths.length === 0 && keywords.length > 0) {
    try {
      const result = await searchRepos(keywords, [item.repo], MAX_SEARCH_MATCHES_PER_ITEM);
      for (const match of result.matches) {
        codeSnippets.push({
          path: `${match.repo}/${match.path}`,
          language: match.language,
          snippet: truncate(match.snippet, MAX_SNIPPET_CHARS),
        });
      }
      if (result.repoErrors?.length) {
        errors.push(...result.repoErrors);
      }
    } catch (e) {
      errors.push(`Search failed: ${String(e)}`);
    }
  }

  if (keywords.length === 0 && filePaths.length === 0) {
    errors.push("No keywords or file_paths provided — cannot retrieve evidence.");
  }

  return {
    text: item.text,
    repo: item.repo,
    searchedKeywords: keywords,
    fetchedPaths,
    codeSnippets,
    flowChains,
    errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerFactCheckTool(server: McpServer): void {
  const repoList = REFERENCE_REPOS.join(", ");

  // ── Stage 1: Planning ──────────────────────────────────────────────────────

  server.registerTool("factcheck", {
    title: "FactCheck — Plan",
    description:
      "Stage 1 of fact-checking: analyzes a document against reference repositories.\n\n" +
      "Returns the document, repository context (README + source file tree), and instructions " +
      "for you (the AI) to extract validation items. After analyzing, call `factcheck_validate` " +
      "with the items you identified.\n\n" +
      "IMPORTANT: This is a closed-loop pipeline. Do NOT call `query`, `suggestion`, or any " +
      "NotebookLM-backed tool during fact-checking. Do NOT use web search or fetch external URLs. " +
      "All evidence must come from `factcheck_validate` only.\n\n" +
      `Available repositories: ${repoList}`,
    inputSchema: {
      document: z.string().describe(
        "The document or text to fact-check against source code.",
      ),
      claims: z.array(z.string()).optional().describe(
        "Optional explicit claims to append to the document for validation.",
      ),
      repos: z.array(z.string()).optional().describe(
        `Optional repository subset. If omitted, all are available: ${repoList}`,
      ),
    },
  }, async ({ document, claims, repos }) => {
    const effectiveDocument = (document ?? "").trim();
    const explicitClaims = (claims ?? []).map(c => c.trim()).filter(Boolean);

    if (!effectiveDocument && explicitClaims.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No document or claims provided. Supply a `document` to fact-check.",
        }],
      };
    }

    const candidateRepos = repos?.length ? [...repos] : [...REFERENCE_REPOS];
    validateRepos(candidateRepos);

    // Build full input text
    const docParts: string[] = [];
    if (effectiveDocument) docParts.push(effectiveDocument);
    if (explicitClaims.length > 0) {
      docParts.push("\n\n### Additional Claims\n");
      docParts.push(explicitClaims.map((c, i) => `${i + 1}. ${c}`).join("\n"));
    }
    const fullDocument = docParts.join("\n");

    // Fetch repo context and tree in parallel for each repo
    const repoSections: string[] = [];
    const repoFetches = candidateRepos.map(async (repo) => {
      const [context, tree] = await Promise.allSettled([
        fetchRepoContext(repo),
        getTree(repo),
      ]);

      const section: string[] = [];
      section.push(`### ${repo}`);

      if (context.status === "fulfilled" && context.value.summary) {
        section.push("");
        section.push("**Context:**");
        section.push(truncate(context.value.summary, 2000));
      }

      if (tree.status === "fulfilled") {
        const filtered = filterTree(tree.value);
        section.push("");
        section.push(`**Source tree** (${filtered.length} files, filtered from ${tree.value.length} total):`);
        section.push("```");
        section.push(filtered.join("\n"));
        section.push("```");
      }

      return section.join("\n");
    });

    const results = await Promise.all(repoFetches);
    repoSections.push(...results);

    const text = buildPlanningResponse(fullDocument, candidateRepos, repoSections);
    return { content: [{ type: "text" as const, text }] };
  });

  // ── Stage 2: Validation ────────────────────────────────────────────────────

  server.registerTool("factcheck_validate", {
    title: "FactCheck — Validate",
    description:
      "Stage 2 of fact-checking: retrieves actual code evidence for each validation item " +
      "and returns it for you (the AI) to judge.\n\n" +
      "Call this after `factcheck` has helped you identify items to validate. " +
      "For each item, provide the claim text, target repository, and search keywords " +
      "or specific file paths. The tool fetches the code and returns it alongside " +
      "each claim for your assessment.\n\n" +
      "IMPORTANT: Do NOT call `query`, `suggestion`, or any NotebookLM-backed tool. " +
      "Do NOT use web search or fetch external URLs. " +
      "Base all verdicts exclusively on the code evidence returned by this tool.\n\n" +
      `Available repositories: ${repoList}`,
    inputSchema: {
      document: z.string().optional().describe(
        "The original document (for reference in validation). Can be condensed.",
      ),
      items: z.array(z.record(z.any())).describe(
        "Validation items. Each object must have: " +
        "text (string, the claim to validate), " +
        "repo (string, owner/repo format), " +
        "keywords (optional string[], search terms), " +
        "file_paths (optional string[], specific file paths to fetch). " +
        "Max 20 items.",
      ),
    },
  }, async ({ document, items }) => {
    if (!items?.length) {
      return {
        content: [{
          type: "text" as const,
          text: "No validation items provided. Call `factcheck` first to plan items.",
        }],
      };
    }

    // Coerce items into the expected shape
    const parsed: ValidationItemInput[] = [];
    for (const raw of items) {
      const text = typeof raw.text === "string" ? raw.text.trim()
        : raw.text != null ? String(raw.text).trim()
        : "";
      const repo = typeof raw.repo === "string" ? raw.repo.trim()
        : raw.repo != null ? String(raw.repo).trim()
        : "";
      if (!text || !repo) continue;
      const keywords = Array.isArray(raw.keywords)
        ? raw.keywords.map((k: unknown) => String(k ?? "").trim()).filter(Boolean)
        : [];
      const filePaths = Array.isArray(raw.file_paths)
        ? raw.file_paths.map((p: unknown) => String(p ?? "").trim()).filter(Boolean)
        : [];
      parsed.push({ text, repo, keywords, file_paths: filePaths });
      if (parsed.length >= MAX_ITEMS) break;
    }

    if (parsed.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No valid items after parsing. Each item needs at least `text` (string) and `repo` (string).",
        }],
      };
    }

    // Validate all referenced repos
    const uniqueRepos = [...new Set(parsed.map(i => i.repo))];
    validateRepos(uniqueRepos);

    // Retrieve evidence with limited concurrency to avoid GitHub rate limits.
    const evidenceResults: ItemEvidence[] = [];
    for (let i = 0; i < parsed.length; i += MAX_CONCURRENCY) {
      const batch = parsed.slice(i, i + MAX_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(item => retrieveEvidence(item)),
      );
      evidenceResults.push(...batchResults);
    }

    const text = buildValidationResponse(
      (document ?? "").trim(),
      evidenceResults,
    );
    return { content: [{ type: "text" as const, text }] };
  });
}
