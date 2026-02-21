import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_TOKEN, REFERENCE_REPOS } from "../config.js";

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Client — Trees API + Code Search API + raw.githubusercontent.com
//
// Strategy:
//   1. Fetch full file tree per repo via Git Trees API (1 API call, cached)
//   2. Find relevant files via TWO parallel strategies:
//      a. Match keywords against file paths (in-memory, instant)
//      b. GitHub Code Search API to find files by content (1 API call per repo)
//   3. Fetch file content from raw.githubusercontent.com (no auth, no rate limit)
//   4. Grep fetched content for keyword matches, extract snippets
//   5. Persist fetched GitHub data on disk so future tool calls are faster
// ─────────────────────────────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const MAIN_BRANCH = "main";

// ── Persistent cache (memory + disk) ────────────────────────────────────────

const CACHE_DIR = process.env.GITHUB_CACHE_DIR ?? join(tmpdir(), "altus-tutor-mcp", "github-cache");
const TREE_TTL_MS = Number(process.env.GITHUB_CACHE_TREE_TTL_MS ?? 6 * 60 * 60 * 1000);
const RAW_FILE_TTL_MS = Number(process.env.GITHUB_CACHE_RAW_FILE_TTL_MS ?? 30 * 60 * 1000);
const CODE_SEARCH_TTL_MS = Number(process.env.GITHUB_CACHE_CODE_SEARCH_TTL_MS ?? 15 * 60 * 1000);

interface CacheEnvelope<T> {
  expiresAt: number;
  value: T;
}

const memoryCache = new Map<string, CacheEnvelope<unknown>>();
const inFlightLoads = new Map<string, Promise<unknown>>();
let cacheDirReady: Promise<void> | null = null;

function nowMs(): number {
  return Date.now();
}

function cachePath(key: string): string {
  const hash = createHash("sha1").update(key).digest("hex");
  return join(CACHE_DIR, `${hash}.json`);
}

async function ensureCacheDir(): Promise<void> {
  if (!cacheDirReady) {
    cacheDirReady = fs.mkdir(CACHE_DIR, { recursive: true })
      .then(() => undefined)
      .catch(() => undefined);
  }
  await cacheDirReady;
}

async function readCache<T>(key: string): Promise<T | undefined> {
  const inMemory = memoryCache.get(key);
  if (inMemory) {
    if (inMemory.expiresAt > nowMs()) {
      return inMemory.value as T;
    }
    memoryCache.delete(key);
  }

  try {
    await ensureCacheDir();
    const raw = await fs.readFile(cachePath(key), "utf8");
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.expiresAt !== "number") {
      return undefined;
    }
    if (parsed.expiresAt <= nowMs()) {
      void fs.unlink(cachePath(key)).catch(() => undefined);
      return undefined;
    }
    memoryCache.set(key, parsed as CacheEnvelope<unknown>);
    return parsed.value;
  } catch {
    return undefined;
  }
}

async function writeCache<T>(key: string, value: T, ttlMs: number): Promise<void> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const envelope: CacheEnvelope<T> = {
    expiresAt: nowMs() + ttlMs,
    value,
  };
  memoryCache.set(key, envelope as CacheEnvelope<unknown>);

  try {
    await ensureCacheDir();
    const target = cachePath(key);
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, JSON.stringify(envelope), "utf8");
    await fs.rename(temp, target);
  } catch {
    // Best-effort persistent cache: ignore write failures.
  }
}

async function getOrLoadCached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const cached = await readCache<T>(key);
  if (cached !== undefined) return cached;

  const inflight = inFlightLoads.get(key);
  if (inflight) return inflight as Promise<T>;

  const pending = (async () => {
    const loaded = await loader();
    await writeCache(key, loaded, ttlMs);
    return loaded;
  })().finally(() => {
    inFlightLoads.delete(key);
  });

  inFlightLoads.set(key, pending as Promise<unknown>);
  return pending;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

export interface SearchMatch {
  repo: string;
  path: string;
  language: string;
  /** ±N lines of code around each keyword match */
  snippet: string;
}

export interface SearchResult {
  query: string;
  matches: SearchMatch[];
  totalPathMatches: number;
  repoErrors?: string[];
}

export interface RepoContext {
  repo: string;
  summary: string;
}

export interface FlowKeywordChains {
  keyword: string;
  chains: string[];
}

export interface FlowAnalysisResult {
  query: string;
  filesAnalyzed: number;
  symbolsIndexed: number;
  edgesIndexed: number;
  entrypoints: string[];
  keywordChains: FlowKeywordChains[];
  repoErrors?: string[];
}

// ── Language map ─────────────────────────────────────────────────────────────

const LANG_MAP: Record<string, string> = {
  rs: "rust", ts: "typescript", js: "javascript", py: "python",
  go: "go", sol: "solidity", toml: "toml", yaml: "yaml", yml: "yaml",
  json: "json", md: "markdown", sh: "bash", dockerfile: "dockerfile",
};

// Source code extensions to search in
const CODE_EXTS = new Set([
  "rs", "ts", "js", "py", "go", "sol", "toml", "yaml", "yml", "sh",
  "tsx", "jsx", "c", "cpp", "h", "hpp", "java", "kt", "swift",
]);

export function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_MAP[ext] ?? ext;
}

function isCodeFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CODE_EXTS.has(ext);
}

// ── API helpers ──────────────────────────────────────────────────────────────

function apiHeaders(): Record<string, string> {
  if (!GITHUB_TOKEN) {
    throw new Error(
      "GITHUB_TOKEN is required. " +
      "Create a personal access token at https://github.com/settings/tokens (no scopes needed for public repos) " +
      "and add GITHUB_TOKEN=<token> to your .env file."
    );
  }
  return {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "altus-tutor-mcp",
    "Authorization": `Bearer ${GITHUB_TOKEN}`,
  };
}

export function validateRepos(repos: readonly string[]): void {
  for (const r of repos) {
    if (!REFERENCE_REPOS.includes(r)) {
      throw new Error(
        `Repository "${r}" is not in the configured reference repos. ` +
        `Allowed: ${REFERENCE_REPOS.join(", ")}`
      );
    }
  }
}

// ── Tree cache ───────────────────────────────────────────────────────────────

const treeCache = new Map<string, TreeEntry[]>();

function treeCacheKey(repo: string): string {
  return `${repo}@${MAIN_BRANCH}`;
}

/**
 * Fetch the full recursive file tree for a repo.
 * Uses Git Trees API with `?recursive=1` — one API call returns everything.
 * Cached in memory after first fetch.
 */
export async function getTree(repo: string, ref?: string): Promise<TreeEntry[]> {
  void ref; // main-only retrieval policy
  const memKey = treeCacheKey(repo);
  const cached = treeCache.get(memKey);
  if (cached) return cached;
  const resolvedRef = MAIN_BRANCH;
  const entries = await getOrLoadCached<TreeEntry[]>(
    `tree:${repo}:${resolvedRef}`,
    TREE_TTL_MS,
    async () => {
      const url = `${GITHUB_API}/repos/${repo}/git/trees/${resolvedRef}?recursive=1`;
      const res = await fetch(url, { headers: apiHeaders() });
      if (!res.ok) throw new Error(`Failed to fetch tree for ${repo}: ${res.status}`);

      const data = await res.json() as {
        tree: Array<{ path: string; type: string; size?: number }>;
        truncated: boolean;
      };

      return data.tree
        .filter(e => e.type === "blob")
        .map(e => ({ path: e.path, type: "blob" as const, size: e.size }));
    }
  );

  treeCache.set(memKey, entries);
  console.error(`[tree] ${repo}: ${entries.length} files cached`);
  return entries;
}

/**
 * Preload trees for all reference repos at server startup.
 */
export function preloadTrees(): void {
  for (const repo of REFERENCE_REPOS) {
    getTree(repo, undefined).catch(e => console.error(`[tree] failed to preload ${repo}:`, e));
  }
}

// ── File fetch (raw.githubusercontent.com) ───────────────────────────────────

/**
 * Fetch a file from raw.githubusercontent.com.
 * No auth needed, no rate limit for public repos.
 */
export async function fetchRawFile(repo: string, path: string, ref?: string): Promise<string | null> {
  try {
    void ref; // main-only retrieval policy
    const refKey = MAIN_BRANCH;
    return await getOrLoadCached<string | null>(
      `raw:${repo}:${refKey}:${path}`,
      RAW_FILE_TTL_MS,
      async () => {
        const mainRes = await fetch(`${RAW_BASE}/${repo}/${MAIN_BRANCH}/${path}`);
        if (mainRes.ok) return await mainRes.text();

        return null;
      }
    );
  } catch {
    return null;
  }
}

// ── Search: path matching + content grep ─────────────────────────────────────

const CONTEXT_LINES = 15; // ±15 lines around each match
const MAX_SNIPPET_MATCHES = 2; // max keyword matches to show per file
const MAX_FILES_TO_GREP = 25; // max files to fetch and grep

// Noise tokens to skip when cleaning keywords
const NOISE_TOKENS = new Set([
  "src", "bin", "lib", "mod", "pub", "use", "let", "mut", "ref", "the",
  "and", "for", "with", "from", "into", "type", "impl", "self", "super",
  "crate", "main", "test", "new", "true", "false", "none", "some",
  "string", "vec", "option", "result", "state",
]);

const CODE_SEARCH_STOP_WORDS = new Set([
  "architecture", "architectural", "advisor", "analysis", "reasoning",
  "summary", "question", "answer", "research", "validate", "validation",
  "document", "implementation", "important", "response", "formatting",
  "instructions", "commonware", "team", "members", "knowledge", "actual",
  "source", "context", "expertise", "performance", "modularity",
]);

/**
 * Split PascalCase/camelCase identifiers into sub-tokens.
 * E.g. "FeedStateHandle" → ["Feed", "State", "Handle"]
 */
function splitCamelCase(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Clean raw keywords from the AI client.
 * Splits compound terms like "Arc<RwLock<FeedState>>" into ["arc", "rwlock", "feedstate"].
 * Also splits PascalCase: "FeedStateHandle" → ["feedstatehandle", "feed", "handle"].
 * Strips paths, removes noise tokens.
 * Returns deduplicated lowercase tokens ≥ 3 chars.
 */
function cleanKeywords(raw: string[]): string[] {
  const tokens = new Set<string>();
  for (const kw of raw) {
    const parts = kw.split(/[^a-zA-Z0-9_]+/).filter(Boolean);
    for (const part of parts) {
      // Add the full token (e.g. "feedstatehandle")
      const lower = part.toLowerCase();
      if (lower.length >= 3 && !NOISE_TOKENS.has(lower)) tokens.add(lower);

      // Also add PascalCase/camelCase sub-tokens for better path matching
      for (const sub of splitCamelCase(part)) {
        const subLower = sub.toLowerCase();
        if (subLower.length >= 3 && !NOISE_TOKENS.has(subLower)) tokens.add(subLower);
      }
    }
  }
  return [...tokens];
}

// ── GitHub Code Search API (content-aware file finder) ──────────────────────

/**
 * Use GitHub Code Search API to find files containing specific terms.
 * This complements tree-based path matching — it finds files where keywords
 * appear in CONTENT, not just in the file path.
 *
 * Rate limit: 10 requests/min for authenticated users.
 * We use it sparingly: 1 call per repo per search.
 */
async function findFilesViaCodeSearch(
  rawKeywords: string[],
  repo: string,
  ref?: string,
  perPage = 10,
): Promise<string[]> {
  void ref; // main-only retrieval policy

  const allTokens = rawKeywords
    .flatMap(k => k.split(/[^a-zA-Z0-9_]+/))
    .filter(t => t.length >= 3);

  const scored = allTokens.map(token => {
    const lower = token.toLowerCase();
    let score = 0;
    if (token.includes("_")) score += 3;
    if (/[A-Z]/.test(token)) score += 3;
    if (/[0-9]/.test(token)) score += 1;
    if (token.length >= 5 && token.length <= 24) score += 1;
    if (CODE_SEARCH_STOP_WORDS.has(lower) || NOISE_TOKENS.has(lower)) score -= 4;
    return { token, lower, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.token.length - a.token.length;
  });

  const seen = new Set<string>();
  const queryTokens: string[] = [];
  for (const t of scored) {
    if (t.score <= 0) continue;
    if (seen.has(t.lower)) continue;
    seen.add(t.lower);
    queryTokens.push(t.token);
    if (queryTokens.length >= 3) break;
  }

  const queryTerms = queryTokens.join(" ");
  if (!queryTerms) return [];

  const cacheKey = `code-search:${repo}:${perPage}:${queryTerms.toLowerCase()}`;
  try {
    return await getOrLoadCached<string[]>(cacheKey, CODE_SEARCH_TTL_MS, async () => {
      const q = encodeURIComponent(`${queryTerms} repo:${repo}`);
      const url = `${GITHUB_API}/search/code?q=${q}&per_page=${perPage}`;
      const res = await fetch(url, { headers: apiHeaders() });
      if (!res.ok) {
        console.error(`[code-search-api] ${res.status} for repo ${repo}: ${queryTerms}`);
        throw new Error(`GitHub code search failed for ${repo}: ${res.status}`);
      }

      const data = await res.json() as {
        items?: Array<{ path: string }>;
      };

      const paths = (data.items ?? []).map(item => item.path);
      console.error(`[code-search-api] ${repo}: found ${paths.length} files for "${queryTerms}"`);
      return paths;
    });
  } catch (e) {
    console.error(`[code-search-api] error for ${repo}:`, e);
    return [];
  }
}

/**
 * Search reference repos by:
 * 1. Cleaning keywords (split compound terms, split PascalCase, strip special chars)
 * 2. In PARALLEL: match keywords against file paths (tree) AND find files via Code Search API
 * 3. Merge file lists, fetch content from raw.githubusercontent.com
 * 4. Grep content for keyword matches, extract snippets
 */
export async function searchRepos(
  keywords: string[],
  repos?: readonly string[],
  maxResults = 5,
  ref?: string,
): Promise<SearchResult> {
  const targetRepos = repos?.length ? [...repos] : [...REFERENCE_REPOS];
  validateRepos(targetRepos);

  const lowerKeywords = cleanKeywords(keywords);
  if (lowerKeywords.length === 0) {
    return { query: keywords.join(" "), matches: [], totalPathMatches: 0 };
  }

  // Kick off GitHub Code Search API in parallel with tree-based matching.
  // This finds files by CONTENT — catches symbols that don't appear in file paths.
  const apiSearchPromise = Promise.all(
    targetRepos.map(async (repo) => {
      const paths = await findFilesViaCodeSearch(keywords, repo, ref);
      return paths.map(path => ({ repo, path }));
    })
  ).then(results => results.flat())
   .catch(() => [] as { repo: string; path: string }[]);

  // Step 1: Get trees and find path matches
  interface PathMatch {
    repo: string;
    path: string;
    score: number;
  }

  const repoErrors: string[] = [];
  const repoTrees = new Map<string, TreeEntry[]>();
  for (const repo of targetRepos) {
    try {
      const tree = await getTree(repo, ref);
      repoTrees.set(repo, tree);
    } catch (e) {
      repoErrors.push(`${repo}: ${String(e)}`);
    }
  }

  if (repoTrees.size === 0) {
    return {
      query: keywords.join(" "),
      matches: [],
      totalPathMatches: 0,
      repoErrors,
    };
  }

  const allPathMatches: PathMatch[] = [];

  for (const [repo, tree] of repoTrees) {
    for (const entry of tree) {
      if (!isCodeFile(entry.path)) continue;

      const lowerPath = entry.path.toLowerCase();
      let score = 0;
      for (const kw of lowerKeywords) {
        if (lowerPath.includes(kw)) score += 2;
      }
      const segments = lowerPath.split("/");
      const fileName = segments[segments.length - 1].replace(/\.[^.]+$/, "");
      for (const kw of lowerKeywords) {
        if (fileName.includes(kw)) score += 3;
      }
      if (score > 0) {
        allPathMatches.push({ repo, path: entry.path, score });
      }
    }
  }

  allPathMatches.sort((a, b) => b.score - a.score);

  // Step 2: Build file list to grep
  const seenFiles = new Set<string>();
  const filesToGrep: PathMatch[] = [];

  const addFile = (repo: string, path: string, score: number) => {
    const key = `${repo}:${path}`;
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    filesToGrep.push({ repo, path, score });
  };

  // Add path-matched files first
  for (const m of allPathMatches.slice(0, MAX_FILES_TO_GREP)) {
    addFile(m.repo, m.path, m.score);
  }

  // If few path matches, broaden: add files from directories that partially
  // match keywords, AND sample .rs files from common source directories
  if (filesToGrep.length < MAX_FILES_TO_GREP) {
    for (const [repo, tree] of repoTrees) {
      for (const entry of tree) {
        if (!isCodeFile(entry.path)) continue;

        const lowerPath = entry.path.toLowerCase();

        // Match on directory names containing keywords
        const dirs = lowerPath.split("/").slice(0, -1);
        for (const kw of lowerKeywords) {
          if (dirs.some(d => d.includes(kw))) {
            addFile(repo, entry.path, 1);
            break;
          }
        }
        if (filesToGrep.length >= MAX_FILES_TO_GREP) break;
      }
      if (filesToGrep.length >= MAX_FILES_TO_GREP) break;
    }
  }

  // If STILL few matches, sample code files from src/bin/crates directories
  // These are most likely to contain implementation code
  if (filesToGrep.length < MAX_FILES_TO_GREP) {
    for (const [repo, tree] of repoTrees) {
      // Prioritize files in typical source directories
      const srcFiles = tree.filter(e =>
        isCodeFile(e.path) &&
        /^(src|bin|crates|lib|packages)\//.test(e.path)
      );
      // Sort by size descending — larger files are more likely to have the code
      srcFiles.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      for (const entry of srcFiles.slice(0, 30)) {
        addFile(repo, entry.path, 0);
        if (filesToGrep.length >= MAX_FILES_TO_GREP) break;
      }
      if (filesToGrep.length >= MAX_FILES_TO_GREP) break;
    }
  }

  // Step 2.5: Merge files discovered by GitHub Code Search API
  // These are high-value — the API confirmed they contain our keywords.
  try {
    const apiFiles = await apiSearchPromise;
    for (const f of apiFiles) {
      if (isCodeFile(f.path)) {
        addFile(f.repo, f.path, 5);
      }
    }
  } catch {
    // Code Search API failed; continue with tree-based results only
  }

  // Step 3: Fetch files in parallel and extract matching snippets
  const scoredMatches: Array<SearchMatch & { score: number }> = [];

  const fetchResults = await Promise.allSettled(
    filesToGrep.map(async (f) => {
      const content = await fetchRawFile(f.repo, f.path, ref);
      if (!content) return null;
      return { repo: f.repo, path: f.path, content, pathScore: f.score };
    })
  );

  for (const result of fetchResults) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const { repo, path, content, pathScore } = result.value;

    const lines = content.split("\n");
    const lang = inferLanguage(path);

    // Find lines that contain any keyword
    const matchingLineNums: { line: number; score: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const lowerLine = lines[i].toLowerCase();
      let lineScore = 0;
      for (const kw of lowerKeywords) {
        if (lowerLine.includes(kw)) lineScore++;
      }
      if (lineScore > 0) {
        matchingLineNums.push({ line: i, score: lineScore });
      }
    }

    // If file path matched strongly but no content matches, show overview
    if (matchingLineNums.length === 0 && pathScore >= 3) {
      const end = Math.min(lines.length, 30);
      const snippet = lines.slice(0, end)
        .map((l, i) => `${String(i + 1).padStart(4)} | ${l}`)
        .join("\n");
      scoredMatches.push({
        repo,
        path,
        language: lang,
        score: pathScore,
        snippet: `\`\`\`${lang}\n// ${path} (lines 1–${end})\n${snippet}\n\`\`\``,
      });
      continue;
    }

    if (matchingLineNums.length === 0) continue;

    // Sort by score, take top N match locations
    matchingLineNums.sort((a, b) => b.score - a.score);
    const shown = new Set<number>();
    const snippets: string[] = [];

    for (const { line } of matchingLineNums.slice(0, MAX_SNIPPET_MATCHES)) {
      if (shown.has(line)) continue;

      const start = Math.max(0, line - CONTEXT_LINES);
      const end = Math.min(lines.length, line + CONTEXT_LINES + 1);

      let overlaps = false;
      for (let i = start; i < end; i++) {
        if (shown.has(i)) { overlaps = true; break; }
      }
      if (overlaps) continue;

      for (let i = start; i < end; i++) shown.add(i);

      const section = lines.slice(start, end)
        .map((l, i) => `${String(start + i + 1).padStart(4)} | ${l}`)
        .join("\n");

      snippets.push(`\`\`\`${lang}\n// ${path} (lines ${start + 1}–${end})\n${section}\n\`\`\``);
    }

    if (snippets.length > 0) {
      const contentScore = matchingLineNums
        .slice(0, MAX_SNIPPET_MATCHES)
        .reduce((sum, m) => sum + m.score, 0);

      scoredMatches.push({
        repo,
        path,
        language: lang,
        score: contentScore + pathScore,
        snippet: snippets.join("\n\n"),
      });
    }
  }

  scoredMatches.sort((a, b) => b.score - a.score);
  const matches = scoredMatches.map(({ score: _score, ...m }) => m);

  return {
    query: keywords.join(" "),
    matches: matches.slice(0, maxResults),
    totalPathMatches: allPathMatches.length,
    repoErrors: repoErrors.length > 0 ? repoErrors : undefined,
  };
}

// ── Flow analysis: static call graph reconstruction ─────────────────────────

interface FlowFile {
  repo: string;
  path: string;
  score: number;
}

interface FlowSymbol {
  id: string;
  repo: string;
  path: string;
  name: string;
  line: number;
  calls: string[];
}

const FLOW_MAX_CANDIDATE_FILES = 50;
const FLOW_MAX_SYMBOLS_PER_FILE = 100;
const FLOW_MAX_EDGES_PER_SYMBOL = 10;
const FLOW_MAX_CHAIN_DEPTH = 6;
const FLOW_MAX_CHAINS_PER_KEYWORD = 3;
const FLOW_MAX_KEYWORDS = 14;

const CALL_STOP_WORDS = new Set([
  "if", "else", "for", "while", "loop", "match", "return", "await", "async",
  "fn", "function", "new", "drop", "clone", "default", "from", "into", "try",
  "ok", "err", "some", "none", "vec", "string", "result", "option",
  "true", "false", "self", "super", "crate", "std",
]);

const ENTRYPOINT_NAMES = new Set([
  "main", "run", "start", "bootstrap", "execute", "handle", "serve",
  "process", "dispatch", "spawn", "init", "initialize",
]);

function scorePathForFlow(path: string, keywords: readonly string[]): number {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? lowerPath;
  let score = 0;

  for (const kw of keywords) {
    if (lowerPath.includes(kw)) score += 2;
    if (fileName.includes(kw)) score += 2;
  }

  if (/\/(src|bin|crates|lib|packages)\//.test(`/${lowerPath}`)) score += 1;
  if (/main\.(rs|ts|js|go|py)$/.test(fileName)) score += 2;
  if (/rpc|consensus|engine|actor|handler|service/.test(lowerPath)) score += 1;

  return score;
}

function addFlowCandidate(
  bag: Map<string, FlowFile>,
  repo: string,
  path: string,
  score: number,
): void {
  const key = `${repo}:${path}`;
  const existing = bag.get(key);
  if (!existing || score > existing.score) {
    bag.set(key, { repo, path, score });
  }
}

async function collectFlowCandidateFiles(
  rawKeywords: readonly string[],
  repos: readonly string[],
  ref: string | undefined,
  maxFiles: number,
): Promise<{ candidates: FlowFile[]; repoErrors: string[] }> {
  const keywords = cleanKeywords([...rawKeywords]).slice(0, FLOW_MAX_KEYWORDS);
  const candidates = new Map<string, FlowFile>();
  const repoErrors: string[] = [];

  if (keywords.length === 0) return { candidates: [], repoErrors };

  // Seed with normal implementation search matches.
  const seed = await searchRepos(keywords, repos, Math.min(12, maxFiles), ref);
  if (seed.repoErrors?.length) repoErrors.push(...seed.repoErrors);
  for (const match of seed.matches) {
    addFlowCandidate(candidates, match.repo, match.path, 30);
  }

  for (const repo of repos) {
    let tree: TreeEntry[];
    try {
      tree = await getTree(repo, ref);
    } catch (e) {
      repoErrors.push(`${repo}: ${String(e)}`);
      continue;
    }

    // Path-based ranking for likely implementation files.
    for (const entry of tree) {
      if (!isCodeFile(entry.path)) continue;
      const score = scorePathForFlow(entry.path, keywords);
      if (score > 0) {
        addFlowCandidate(candidates, repo, entry.path, score);
      }
    }

    // Expand around seed directories to capture call neighbors.
    const seedPaths = [...candidates.values()]
      .filter(c => c.repo === repo)
      .map(c => c.path);

    const seedDirs = new Set(
      seedPaths
        .map(p => p.split("/").slice(0, -1).join("/"))
        .filter(Boolean),
    );

    for (const entry of tree) {
      if (!isCodeFile(entry.path)) continue;
      const dir = entry.path.split("/").slice(0, -1).join("/");
      if (seedDirs.has(dir)) {
        addFlowCandidate(candidates, repo, entry.path, 8);
      }
    }
  }

  return {
    candidates: [...candidates.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(10, Math.min(maxFiles, FLOW_MAX_CANDIDATE_FILES))),
    repoErrors,
  };
}

function extractFunctionName(line: string): string | null {
  const rust = line.match(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (rust) return rust[1];

  const js = line.match(/\b(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (js) return js[1];

  const arrow = line.match(/\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
  if (arrow) return arrow[1];

  return null;
}

function extractCallNames(block: string): string[] {
  const calls = new Set<string>();

  const pathCallRe = /(?:[A-Za-z_][A-Za-z0-9_]*::)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const methodCallRe = /\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const directCallRe = /(?:^|[^.\w:])([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

  let match: RegExpExecArray | null;
  while ((match = pathCallRe.exec(block)) !== null) {
    calls.add(match[1].toLowerCase());
  }
  while ((match = methodCallRe.exec(block)) !== null) {
    calls.add(match[1].toLowerCase());
  }
  while ((match = directCallRe.exec(block)) !== null) {
    calls.add(match[1].toLowerCase());
  }

  return [...calls]
    .filter(name => name.length >= 2 && !CALL_STOP_WORDS.has(name))
    .slice(0, 60);
}

function parseFlowSymbols(repo: string, path: string, content: string): FlowSymbol[] {
  const lines = content.split("\n");
  const decls: Array<{ name: string; start: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const name = extractFunctionName(lines[i]);
    if (name) decls.push({ name, start: i });
    if (decls.length >= FLOW_MAX_SYMBOLS_PER_FILE) break;
  }

  if (decls.length === 0) return [];

  const symbols: FlowSymbol[] = [];

  for (let i = 0; i < decls.length; i++) {
    const cur = decls[i];
    const next = decls[i + 1];
    const start = cur.start;
    const end = next ? Math.max(start, next.start - 1) : lines.length - 1;
    const block = lines.slice(start, end + 1).join("\n");
    const calls = extractCallNames(block).filter(name => name !== cur.name.toLowerCase());

    symbols.push({
      id: `${repo}:${path}:${start + 1}:${cur.name}`,
      repo,
      path,
      name: cur.name,
      line: start + 1,
      calls,
    });
  }

  return symbols;
}

function buildFlowAdjacency(symbols: readonly FlowSymbol[]): {
  adjacency: Map<string, string[]>;
  symbolById: Map<string, FlowSymbol>;
  edgeCount: number;
} {
  const byName = new Map<string, FlowSymbol[]>();
  const symbolById = new Map<string, FlowSymbol>();

  for (const symbol of symbols) {
    const key = symbol.name.toLowerCase();
    const list = byName.get(key);
    if (!list) {
      byName.set(key, [symbol]);
    } else {
      list.push(symbol);
    }
    symbolById.set(symbol.id, symbol);
  }

  const adjacency = new Map<string, string[]>();
  let edgeCount = 0;

  for (const symbol of symbols) {
    const targets = new Set<string>();

    for (const call of symbol.calls) {
      const defs = byName.get(call) ?? [];
      for (const target of defs) {
        if (target.id === symbol.id) continue;
        targets.add(target.id);
        if (targets.size >= FLOW_MAX_EDGES_PER_SYMBOL) break;
      }
      if (targets.size >= FLOW_MAX_EDGES_PER_SYMBOL) break;
    }

    const out = [...targets];
    adjacency.set(symbol.id, out);
    edgeCount += out.length;
  }

  return { adjacency, symbolById, edgeCount };
}

function selectEntrypoints(
  symbols: readonly FlowSymbol[],
  adjacency: ReadonlyMap<string, string[]>,
  keywords: readonly string[],
): string[] {
  const scored = symbols.map(symbol => {
    const lowerName = symbol.name.toLowerCase();
    const lowerPath = symbol.path.toLowerCase();
    let score = 0;

    if (ENTRYPOINT_NAMES.has(lowerName)) score += 8;
    if (/main\.(rs|ts|js|go|py)$/.test(lowerPath)) score += 6;
    if (/(^|\/)(bin|cmd)\//.test(lowerPath)) score += 3;
    if (/(handler|server|service|engine|actor)/.test(lowerPath)) score += 2;

    for (const kw of keywords) {
      if (lowerPath.includes(kw) || lowerName.includes(kw)) score += 1;
    }

    score += Math.min(3, adjacency.get(symbol.id)?.length ?? 0);

    return { id: symbol.id, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score > 0).slice(0, 12).map(s => s.id);
  if (top.length > 0) return top;

  return symbols.slice(0, 8).map(s => s.id);
}

function formatFlowSymbolLabel(symbol: FlowSymbol): string {
  return `${symbol.name} (${symbol.repo}/${symbol.path}:${symbol.line})`;
}

function findChainsToTargets(
  entryIds: readonly string[],
  targetIds: ReadonlySet<string>,
  adjacency: ReadonlyMap<string, string[]>,
  maxDepth: number,
  maxChains: number,
): string[][] {
  const chains: string[][] = [];

  for (const entry of entryIds) {
    if (chains.length >= maxChains) break;

    const queue: string[][] = [[entry]];
    const seen = new Set<string>([`${entry}:1`]);

    while (queue.length > 0 && chains.length < maxChains) {
      const path = queue.shift()!;
      const current = path[path.length - 1];

      if (targetIds.has(current) && path.length > 1) {
        chains.push(path);
        continue;
      }

      if (path.length >= maxDepth) continue;

      for (const next of adjacency.get(current) ?? []) {
        if (path.includes(next)) continue;
        const key = `${next}:${path.length + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push([...path, next]);
      }
    }
  }

  return chains;
}

export async function analyzeRepoFlow(
  keywords: string[],
  repos?: readonly string[],
  maxFiles = FLOW_MAX_CANDIDATE_FILES,
  ref?: string,
): Promise<FlowAnalysisResult> {
  const targetRepos = repos?.length ? [...repos] : [...REFERENCE_REPOS];
  validateRepos(targetRepos);

  const cleanedKeywords = cleanKeywords(keywords).slice(0, FLOW_MAX_KEYWORDS);
  if (cleanedKeywords.length === 0) {
    return {
      query: keywords.join(" "),
      filesAnalyzed: 0,
      symbolsIndexed: 0,
      edgesIndexed: 0,
      entrypoints: [],
      keywordChains: [],
      repoErrors: [],
    };
  }

  const { candidates, repoErrors } = await collectFlowCandidateFiles(cleanedKeywords, targetRepos, ref, maxFiles);

  const loaded = await Promise.allSettled(
    candidates.map(async (file) => {
      const content = await fetchRawFile(file.repo, file.path, ref);
      if (!content) return null;
      return { ...file, content };
    }),
  );

  const symbols: FlowSymbol[] = [];
  let filesAnalyzed = 0;

  for (const result of loaded) {
    if (result.status !== "fulfilled" || !result.value) continue;
    filesAnalyzed += 1;
    symbols.push(...parseFlowSymbols(result.value.repo, result.value.path, result.value.content));
  }

  const { adjacency, symbolById, edgeCount } = buildFlowAdjacency(symbols);
  const entryIds = selectEntrypoints(symbols, adjacency, cleanedKeywords);

  const keywordChains: FlowKeywordChains[] = [];

  for (const keyword of cleanedKeywords) {
    const targetIds = new Set<string>();
    for (const symbol of symbols) {
      const haystack = `${symbol.name} ${symbol.path}`.toLowerCase();
      if (haystack.includes(keyword)) {
        targetIds.add(symbol.id);
      }
    }

    if (targetIds.size === 0) {
      keywordChains.push({ keyword, chains: [] });
      continue;
    }

    const chainIds = findChainsToTargets(
      entryIds,
      targetIds,
      adjacency,
      FLOW_MAX_CHAIN_DEPTH,
      FLOW_MAX_CHAINS_PER_KEYWORD,
    );

    const rendered = chainIds.map(chain =>
      chain
        .map(id => symbolById.get(id))
        .filter((s): s is FlowSymbol => Boolean(s))
        .map(formatFlowSymbolLabel)
        .join(" -> "),
    );

    keywordChains.push({ keyword, chains: rendered });
  }

  return {
    query: cleanedKeywords.join(" "),
    filesAnalyzed,
    symbolsIndexed: symbols.length,
    edgesIndexed: edgeCount,
    entrypoints: entryIds
      .map(id => symbolById.get(id))
      .filter((s): s is FlowSymbol => Boolean(s))
      .map(formatFlowSymbolLabel),
    keywordChains,
    repoErrors: repoErrors.length > 0 ? repoErrors : undefined,
  };
}

// ── Repo Context ─────────────────────────────────────────────────────────────

const CONTEXT_FILES = ["README.md", "CLAUDE.md", "AGENTS.md", "GEMINI.md"];
const MAX_CONTEXT_BYTES = 2_000;

const repoContextCache = new Map<string, RepoContext>();

export async function fetchRepoContext(repo: string, ref?: string): Promise<RepoContext> {
  const cacheKey = `${repo}@${ref ?? "__default__"}`;
  const cached = repoContextCache.get(cacheKey);
  if (cached) return cached;

  const fetches = CONTEXT_FILES.map(async (name) => {
    try {
      const content = await fetchRawFile(repo, name, ref);
      if (!content) return null;
      const trimmed = content.length > MAX_CONTEXT_BYTES
        ? content.slice(0, MAX_CONTEXT_BYTES) + "…"
        : content;
      return `[${name}]\n${trimmed}`;
    } catch {
      return null;
    }
  });

  const results = (await Promise.all(fetches)).filter(Boolean) as string[];
  const ctx: RepoContext = { repo, summary: results.join("\n\n") };
  repoContextCache.set(cacheKey, ctx);
  return ctx;
}
