/**
 * NotebookLM client — thin wrapper around auth.ts and api.ts.
 *
 * Public API kept identical to the old subprocess-based client so consumers
 * (query.ts, suggestion.ts, factcheck.ts) need zero changes.
 */

import { NOTEBOOK_ID } from "../config.js";
import {
  type AuthTokens,
  loadCachedTokens,
  login as authLogin,
} from "./auth.js";
import { queryNotebook, resetCsrfState } from "./api.js";

// ─────────────────────────────────────────────────────────────────────────────
// Cached Tokens (in-memory)
// ─────────────────────────────────────────────────────────────────────────────

let cachedTokens: AuthTokens | null = null;

async function ensureAuth(): Promise<AuthTokens> {
  if (cachedTokens) return cachedTokens;
  const tokens = loadCachedTokens();
  if (!tokens) {
    throw new Error(
      "Not authenticated. Use the login tool to authenticate with NotebookLM.",
    );
  }
  cachedTokens = tokens;
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API (signatures unchanged)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask a question to NotebookLM.
 *
 * Auth recovery (CSRF refresh, cookie reload) is handled inside
 * queryNotebook / callRpc, so we just need a clean top-level wrapper.
 */
export async function askNotebookLm(question: string): Promise<string> {
  const tokens = await ensureAuth();
  const answer = await queryNotebook(NOTEBOOK_ID, question, tokens);
  return answer || "No response from NotebookLM.";
}

/**
 * Interactive login via Chrome CDP.
 */
export async function login(): Promise<string> {
  const tokens = await authLogin();
  cachedTokens = tokens;
  return "Login successful. Authentication tokens saved.";
}

/**
 * Reload tokens from disk (e.g. after external re-authentication).
 */
export async function refreshAuth(): Promise<string> {
  const tokens = loadCachedTokens();
  if (!tokens) {
    return "No cached tokens found. Use the login tool to authenticate first.";
  }
  cachedTokens = tokens;
  resetCsrfState(); // Force CSRF re-fetch on next API call
  return "Auth tokens reloaded from disk.";
}

/**
 * Clear cached tokens (called during shutdown).
 */
export async function closeClient(): Promise<void> {
  cachedTokens = null;
}

/**
 * Eagerly load cached tokens from disk (fire-and-forget on startup).
 */
export function preloadAuth(): void {
  const tokens = loadCachedTokens();
  if (tokens) cachedTokens = tokens;
}
