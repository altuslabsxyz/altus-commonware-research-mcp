import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchRepos, validateRepos } from "../github/index.js";
import { REFERENCE_REPOS } from "../config.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "and", "or", "but", "is", "are", "was", "were", "be", "been", "being",
  "how", "what", "where", "which", "who", "when", "why", "this", "that",
  "these", "those", "it", "its", "as", "if", "then", "than", "into", "also",
  "can", "will", "would", "should", "could", "may", "might", "must", "not",
  "document", "query", "validate", "validation", "check", "fact", "flow",
  "logic", "component", "diagram", "information", "implementation",
]);

export interface RepoSelectionEntry {
  repo: string;
  score: number;
  codeMatches: number;
  pathMatches: number;
}

export interface RepoSelectionResult {
  repos: string[];
  keywords: string[];
  scored: RepoSelectionEntry[];
  reasons: string[];
  repoErrors: string[];
}

function extractKeywords(input: string, maxKeywords = 12): string[] {
  const freq = new Map<string, number>();
  const tokens = input
    .toLowerCase()
    .split(/[^a-z0-9_:/.-]+/)
    .map(t => t.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const normalized = token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
    if (normalized.length < 3) continue;
    if (STOP_WORDS.has(normalized)) continue;
    freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return b[0].length - a[0].length;
    })
    .map(([token]) => token)
    .slice(0, maxKeywords);
}

function countKeywordHits(text: string, keywords: readonly string[]): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw)) hits += 1;
  }
  return hits;
}

function scoreRepo(
  repo: string,
  keywords: readonly string[],
  codeMatches: Array<{ path: string; snippet: string }>,
  pathMatches: number,
): RepoSelectionEntry {
  let snippetHits = 0;
  let pathHits = 0;
  for (const match of codeMatches) {
    snippetHits += countKeywordHits(match.snippet, keywords);
    pathHits += countKeywordHits(match.path, keywords);
  }

  const score =
    codeMatches.length * 30 +
    snippetHits * 6 +
    pathHits * 3 +
    Math.min(pathMatches, 100);

  return {
    repo,
    score,
    codeMatches: codeMatches.length,
    pathMatches,
  };
}

export async function selectReposForInput(
  input: string,
  options?: {
    candidateRepos?: readonly string[];
    maxRepos?: number;
    precomputedKeywords?: readonly string[];
  },
): Promise<RepoSelectionResult> {
  const candidateRepos = options?.candidateRepos?.length
    ? [...options.candidateRepos]
    : [...REFERENCE_REPOS];
  validateRepos(candidateRepos);

  const maxRepos = Math.max(1, Math.min(options?.maxRepos ?? 3, candidateRepos.length));
  const keywords = options?.precomputedKeywords?.length
    ? [...new Set(options.precomputedKeywords.map(k => k.toLowerCase()).filter(k => k.length >= 3))]
    : extractKeywords(input);

  if (keywords.length === 0) {
    const repos = candidateRepos.slice(0, maxRepos);
    return {
      repos,
      keywords: [],
      scored: repos.map(repo => ({ repo, score: 0, codeMatches: 0, pathMatches: 0 })),
      reasons: ["No strong keywords found; selected default repository order."],
      repoErrors: [],
    };
  }

  const perRepo = await Promise.all(candidateRepos.map(async (repo) => {
    const result = await searchRepos(keywords, [repo], 8);
    const score = scoreRepo(repo, keywords, result.matches, result.totalPathMatches);
    return {
      score,
      repoErrors: result.repoErrors ?? [],
    };
  }));

  const scored = perRepo
    .map(x => x.score)
    .sort((a, b) => b.score - a.score);
  const repoErrors = [...new Set(perRepo.flatMap(x => x.repoErrors))];

  const positive = scored.filter(s => s.score > 0);
  const selected = (positive.length > 0 ? positive : scored).slice(0, maxRepos);
  const repos = selected.map(s => s.repo);

  const reasons = selected.map(s =>
    `${s.repo}: score=${s.score}, codeMatches=${s.codeMatches}, pathMatches=${s.pathMatches}`,
  );

  return { repos, keywords, scored, reasons, repoErrors };
}

export function registerSelectRepositoriesTool(server: McpServer): void {
  const repoList = REFERENCE_REPOS.join(", ");
  server.registerTool("select_repositories", {
    title: "Select Repositories",
    description:
      `Select the most relevant repositories from REFERENCE_REPOS (${repoList}) ` +
      "for a given document/query using retrieval evidence scores.",
    inputSchema: {
      input: z.string().describe("Documentation or query text used to choose relevant repositories."),
      repos: z.array(z.string()).optional().describe(
        `Optional candidate subset. Allowed: ${repoList}`
      ),
      max_repos: z.number().int().min(1).max(4).optional().describe(
        "Maximum repositories to return (default: 3)."
      ),
      keywords: z.array(z.string()).optional().describe(
        "Optional keywords to guide selection. If omitted, extracted from input."
      ),
    },
  }, async ({ input, repos, max_repos, keywords }) => {
    const result = await selectReposForInput(input, {
      candidateRepos: repos,
      maxRepos: max_repos,
      precomputedKeywords: keywords,
    });

    const out: string[] = [];
    out.push("## Repository Selection");
    out.push(`- Selected repos: ${result.repos.join(", ")}`);
    out.push(`- Keywords: ${result.keywords.length > 0 ? result.keywords.join(", ") : "(none)"}`);
    out.push("");
    out.push("| Repo | Score | Code Matches | Path Matches |");
    out.push("|---|---:|---:|---:|");
    for (const row of result.scored) {
      out.push(`| ${row.repo} | ${row.score} | ${row.codeMatches} | ${row.pathMatches} |`);
    }
    if (result.repoErrors.length > 0) {
      out.push("");
      out.push("### Retrieval Warnings");
      for (const err of result.repoErrors.slice(0, 8)) {
        out.push(`- ${err}`);
      }
    }

    return { content: [{ type: "text" as const, text: out.join("\n") }] };
  });
}
