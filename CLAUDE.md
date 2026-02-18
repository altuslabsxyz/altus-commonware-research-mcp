# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Altus Commonware Research MCP — a stdio MCP server that queries Commonware blockchain research via NotebookLM and validates implementation claims against reference GitHub repositories. Built with the MCP SDK, TypeScript (ES2022), ESM modules.

## Build & Run

```bash
npm run build        # tsc → dist/
npm start            # node dist/index.js
```

There are no tests or linting configured. After code changes, run `npm run build` to verify TypeScript compilation succeeds (strict mode, no unused locals/parameters).

## Architecture

### Entry Point & Startup (`src/index.ts`)

Creates an `McpServer` with stdio transport. On startup:
1. Registers all 7 tools via `registerTools(server)`
2. Eagerly pre-connects to the `notebooklm-mcp` subprocess (cold-start optimization)
3. Preloads GitHub tree caches for all `REFERENCE_REPOS`
4. Handles graceful shutdown on SIGINT (closes NotebookLM client + MCP server)

### Configuration (`src/config.ts`)

Loads `.env` relative to compiled `dist/` directory (one level up from `dist/config.js`). Exports:
- `NOTEBOOK_ID` — NotebookLM notebook to query
- `GITHUB_TOKEN` — optional GitHub PAT (avoids rate limits on public repos)
- `REFERENCE_REPOS` — comma-separated `owner/repo` list the tools search against

### Tool Registration (`src/tools/index.ts`)

Each tool lives in its own file under `src/tools/` and exports a `register*Tool(server)` function. To add a new tool: create `src/tools/my-tool.ts`, export a registration function, and call it from `src/tools/index.ts`.

### Tools

| Tool | File | Purpose |
|------|------|---------|
| `login` | `setup-auth.ts` | Prompts user to run `nlm login` in terminal |
| `refresh_auth` | `setup-auth.ts` | Reloads NotebookLM auth tokens from disk |
| `query` | `query.ts` | Direct question to NotebookLM |
| `suggestion` | `suggestion.ts` | Two-stage: research (NotebookLM) + code examples from repos |
| `search_implementation` | `implementation.ts` | Stage 2 of suggestion flow — code snippet retrieval |
| `select_repositories` | `repo-selection.ts` | Auto-selects most relevant repos via keyword scoring |
| `factcheck` | `factcheck.ts` | Validates document claims against reference code (3-stage pipeline) |

### Two-Stage Flow: `suggestion` → `search_implementation`

`suggestion` stores a `SuggestionFlowContext` (question, repos, keywords, 2-hour TTL) in `src/tools/flow-state.ts`. `search_implementation` requires this context to exist — it inherits repo scope and keywords from the preceding suggestion call.

### NotebookLM Client (`src/notebooklm/client.ts`)

Spawns `notebooklm-mcp` CLI as a subprocess via `StdioClientTransport`, communicates using the MCP client SDK. Lazy singleton — initialized on first call, reused thereafter. Key exports: `getClient()`, `askNotebookLm(question)`, `refreshAuth()`, `closeClient()`.

### GitHub Client (`src/github/client.ts`)

The largest module (~1100 lines). Handles:
- **Tree fetching** — GitHub git/trees API with recursive=1, cached in memory + disk
- **Code search** — GitHub Code Search API, keyword specificity ranking
- **Raw file fetching** — `raw.githubusercontent.com`, no auth needed
- **Search pipeline** — `searchRepos()`: fetch trees → path match → code search → fetch files → grep for context → score and rank
- **Flow analysis** — `analyzeRepoFlow()`: call-chain reconstruction for symbols

Cache system: memory → disk (tmpdir) with TTL-based expiration and in-flight deduplication. Cache TTLs configurable via `GITHUB_CACHE_DIR`, `GITHUB_CACHE_TREE_TTL_MS`, `GITHUB_CACHE_RAW_FILE_TTL_MS`, `GITHUB_CACHE_CODE_SEARCH_TTL_MS` env vars.

### Factcheck Pipeline (`src/tools/factcheck.ts`)

Three stages:
1. **AI Planning** — NotebookLM extracts validation items from document/claims, classifies each (fact/flow/component)
2. **Per-Item Retrieval** — parallel `searchRepos()` + `analyzeRepoFlow()` for each claim
3. **Contradiction Detection** — NotebookLM adjudicates each claim against evidence

Verdict types: Verified, Partially Verified, Not Verified, Contradicted, INSUFFICIENT_EVIDENCE.

## Key Patterns

- **Parallel retrieval with graceful degradation** — `Promise.allSettled` for NotebookLM + GitHub calls; partial results returned if one fails
- **Keyword normalization** — camelCase splitting, stop word removal, noise token filtering, lowercase dedup (used across suggestion, factcheck, repo-selection)
- **Formatting instructions embedded in tool responses** — AI advisor prompts are included as content in the response text, not at the tool level
- **Copy-on-read for flow state** — `getLatestSuggestionFlowContext()` returns a copy to prevent mutation
