/**
 * Direct NotebookLM HTTP API client.
 *
 * Communicates with NotebookLM's internal batchexecute / streaming gRPC-style
 * endpoints, ported from notebooklm-mcp-cli's core/base.py + core/conversation.py
 */

import {
  type AuthTokens,
  cookieHeader,
  loadCachedTokens,
  saveTokens,
  validateCookies,
} from "./auth.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = "https://notebooklm.google.com";
const BATCHEXECUTE_URL = `${BASE_URL}/_/LabsTailwindUi/data/batchexecute`;
const QUERY_ENDPOINT =
  "/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed";

const RPC_GET_NOTEBOOK = "rLM1Ne";

const BL_VERSION =
  process.env.NOTEBOOKLM_BL ?? "boq_labs-tailwind-frontend_20260108.06_p0";

const PAGE_FETCH_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

// ─────────────────────────────────────────────────────────────────────────────
// Source ID Cache
// ─────────────────────────────────────────────────────────────────────────────

interface SourceIdCache {
  ids: string[];
  fetchedAt: number;
}

const sourceIdCache = new Map<string, SourceIdCache>();
const SOURCE_ID_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Request Counter (for _reqid parameter)
// ─────────────────────────────────────────────────────────────────────────────

let reqidCounter = Math.floor(Math.random() * 900_000) + 100_000;

// ─────────────────────────────────────────────────────────────────────────────
// CSRF Refresh on First API Call
// ─────────────────────────────────────────────────────────────────────────────

let csrfRefreshed = false;

async function ensureCsrf(tokens: AuthTokens): Promise<void> {
  if (csrfRefreshed) return;
  await refreshAuthTokens(tokens);
  csrfRefreshed = true;
}

/** Reset the CSRF gate so the next API call re-fetches CSRF from the page. */
export function resetCsrfState(): void {
  csrfRefreshed = false;
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC Request/Response Protocol
// ─────────────────────────────────────────────────────────────────────────────

function buildRpcRequestBody(
  rpcId: string,
  params: unknown,
  csrfToken: string,
): string {
  const paramsJson = JSON.stringify(params);
  const fReq = [[[rpcId, paramsJson, null, "generic"]]];
  const fReqJson = JSON.stringify(fReq);

  const parts = [`f.req=${encodeURIComponent(fReqJson)}`];
  if (csrfToken) parts.push(`at=${encodeURIComponent(csrfToken)}`);
  return parts.join("&") + "&";
}

function buildRpcUrl(
  rpcId: string,
  sessionId: string,
  sourcePath = "/",
): string {
  const params = new URLSearchParams({
    rpcids: rpcId,
    "source-path": sourcePath,
    bl: BL_VERSION,
    hl: "en",
    rt: "c",
  });
  if (sessionId) params.set("f.sid", sessionId);
  return `${BATCHEXECUTE_URL}?${params.toString()}`;
}

function parseRpcResponse(responseText: string): unknown[] {
  let text = responseText;
  if (text.startsWith(")]}'")) text = text.slice(4);

  const lines = text.trim().split("\n");
  const results: unknown[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    // Try as byte-count line
    if (/^\d+$/.test(line)) {
      i++;
      if (i < lines.length) {
        try {
          results.push(JSON.parse(lines[i]));
        } catch { /* skip */ }
      }
      i++;
    } else {
      try {
        results.push(JSON.parse(line));
      } catch { /* skip */ }
      i++;
    }
  }

  return results;
}

function extractRpcResult(parsed: unknown[], rpcId: string): unknown {
  for (const chunk of parsed) {
    if (!Array.isArray(chunk)) continue;
    for (const item of chunk) {
      if (!Array.isArray(item) || item.length < 3) continue;
      if (item[0] === "wrb.fr" && item[1] === rpcId) {
        // Check for error signature (auth expired)
        if (
          item.length > 6 &&
          item[6] === "generic" &&
          Array.isArray(item[5]) &&
          item[5].includes(16)
        ) {
          throw new AuthError("RPC Error 16: Authentication expired");
        }
        const resultStr = item[2];
        if (typeof resultStr === "string") {
          try { return JSON.parse(resultStr); } catch { return resultStr; }
        }
        return resultStr;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Error
// ─────────────────────────────────────────────────────────────────────────────

class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

function apiHeaders(tokens: AuthTokens): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    Origin: BASE_URL,
    Referer: `${BASE_URL}/`,
    "X-Same-Domain": "1",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    Cookie: cookieHeader(tokens.cookies),
  };
  if (tokens.csrfToken) {
    headers["X-Goog-Csrf-Token"] = tokens.csrfToken;
  }
  return headers;
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC Call (with auth recovery)
// ─────────────────────────────────────────────────────────────────────────────

async function callRpc(
  rpcId: string,
  params: unknown,
  tokens: AuthTokens,
  opts: { path?: string; timeout?: number; _retry?: boolean; _deepRetry?: boolean } = {},
): Promise<unknown> {
  const { path = "/", timeout = 30000, _retry = false, _deepRetry = false } = opts;

  await ensureCsrf(tokens);

  const body = buildRpcRequestBody(rpcId, params, tokens.csrfToken);
  const url = buildRpcUrl(rpcId, tokens.sessionId, path);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: apiHeaders(tokens),
      body,
      signal: AbortSignal.timeout(timeout),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        throw new AuthError(`HTTP ${resp.status}`);
      }
      throw new Error(`RPC request failed: HTTP ${resp.status}`);
    }

    const text = await resp.text();
    const parsed = parseRpcResponse(text);
    return extractRpcResult(parsed, rpcId);
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;

    // Layer 1: refresh CSRF/session tokens
    if (!_retry) {
      try {
        await refreshAuthTokens(tokens);
        return callRpc(rpcId, params, tokens, { path, timeout, _retry: true, _deepRetry });
      } catch {
        // CSRF refresh failed, continue to layer 2
      }
    }

    // Layer 2: reload cookies from disk
    if (!_deepRetry) {
      const reloaded = loadCachedTokens();
      if (reloaded && validateCookies(reloaded.cookies)) {
        tokens.cookies = reloaded.cookies;
        tokens.csrfToken = "";
        tokens.sessionId = "";
        try {
          await refreshAuthTokens(tokens);
          return callRpc(rpcId, params, tokens, { path, timeout, _retry: true, _deepRetry: true });
        } catch { /* exhausted */ }
      }
    }

    throw new Error(
      "Authentication expired. Use the login tool to re-authenticate.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Refresh Auth Tokens (CSRF + Session ID)
// ─────────────────────────────────────────────────────────────────────────────

export async function refreshAuthTokens(tokens: AuthTokens): Promise<void> {
  const headers: Record<string, string> = {
    ...PAGE_FETCH_HEADERS,
    Cookie: cookieHeader(tokens.cookies),
  };

  const resp = await fetch(`${BASE_URL}/`, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
  });

  // Check for redirect to login page (cookies expired)
  if (resp.url.includes("accounts.google.com")) {
    throw new Error("Authentication expired — redirected to Google login.");
  }

  if (!resp.ok) {
    throw new Error(`Failed to fetch NotebookLM page: HTTP ${resp.status}`);
  }

  const html = await resp.text();

  const csrfMatch = html.match(/"SNlM0e":"([^"]+)"/);
  if (!csrfMatch) {
    throw new Error("Could not extract CSRF token from page. The page structure may have changed.");
  }
  tokens.csrfToken = csrfMatch[1];

  const sidMatch = html.match(/"FdrFJe":"(\d+)"/);
  if (sidMatch) tokens.sessionId = sidMatch[1];

  // Persist updated tokens
  saveTokens(tokens);
}

// ─────────────────────────────────────────────────────────────────────────────
// Notebook Data
// ─────────────────────────────────────────────────────────────────────────────

async function getNotebook(
  notebookId: string,
  tokens: AuthTokens,
): Promise<unknown> {
  return callRpc(
    RPC_GET_NOTEBOOK,
    [notebookId, null, [2], null, 0],
    tokens,
    { path: `/notebook/${notebookId}` },
  );
}

function extractSourceIds(notebookData: unknown): string[] {
  const ids: string[] = [];
  if (!Array.isArray(notebookData)) return ids;

  try {
    const outer = notebookData as unknown[][];
    if (outer.length > 0 && Array.isArray(outer[0])) {
      const info = outer[0] as unknown[];
      if (info.length > 1 && Array.isArray(info[1])) {
        const sources = info[1] as unknown[][];
        for (const source of sources) {
          if (Array.isArray(source) && source.length > 0) {
            const idWrapper = source[0];
            if (Array.isArray(idWrapper) && idWrapper.length > 0) {
              const sourceId = (idWrapper as string[])[0];
              if (typeof sourceId === "string") ids.push(sourceId);
            }
          }
        }
      }
    }
  } catch { /* ignore malformed notebook data */ }

  return ids;
}

async function ensureSourceIds(
  notebookId: string,
  tokens: AuthTokens,
): Promise<string[]> {
  const cached = sourceIdCache.get(notebookId);
  if (cached && Date.now() - cached.fetchedAt < SOURCE_ID_CACHE_TTL_MS) {
    return cached.ids;
  }

  const data = await getNotebook(notebookId, tokens);
  const ids = extractSourceIds(data);
  sourceIdCache.set(notebookId, { ids, fetchedAt: Date.now() });
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Notebook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Query a NotebookLM notebook and return the answer text.
 *
 * Port of Python ConversationMixin.query() + _parse_query_response().
 */
export async function queryNotebook(
  notebookId: string,
  question: string,
  tokens: AuthTokens,
  sourceIds?: string[],
  _retry = false,
): Promise<string> {
  await ensureCsrf(tokens);

  if (!sourceIds) {
    sourceIds = await ensureSourceIds(notebookId, tokens);
  }

  // Build source IDs structure: [[[sid]]] for each source
  const sourcesArray = sourceIds.map((sid) => [[sid]]);

  // Query params structure (from network capture)
  const params = [
    sourcesArray,
    question,
    null, // conversation history (new conversation)
    [2, null, [1]],
    crypto.randomUUID(), // conversation ID
  ];

  const paramsJson = JSON.stringify(params);
  const fReq = [null, paramsJson];
  const fReqJson = JSON.stringify(fReq);

  const bodyParts = [`f.req=${encodeURIComponent(fReqJson)}`];
  if (tokens.csrfToken) {
    bodyParts.push(`at=${encodeURIComponent(tokens.csrfToken)}`);
  }
  const body = bodyParts.join("&") + "&";

  reqidCounter += 100_000;
  const urlParams = new URLSearchParams({
    bl: BL_VERSION,
    hl: "en",
    _reqid: String(reqidCounter),
    rt: "c",
  });
  if (tokens.sessionId) urlParams.set("f.sid", tokens.sessionId);

  const url = `${BASE_URL}${QUERY_ENDPOINT}?${urlParams.toString()}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: apiHeaders(tokens),
      body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new Error(`Query request failed: ${e}`);
  }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      if (_retry) {
        throw new Error("Authentication expired. Use the login tool to re-authenticate.");
      }
      // Auth recovery: refresh tokens and retry once
      await refreshAuthTokens(tokens);
      return queryNotebook(notebookId, question, tokens, sourceIds, true);
    }
    throw new Error(`Query failed: HTTP ${resp.status}`);
  }

  const text = await resp.text();

  try {
    return parseQueryResponse(text);
  } catch (e) {
    if (e instanceof AuthError && !_retry) {
      await refreshAuthTokens(tokens);
      return queryNotebook(notebookId, question, tokens, sourceIds, true);
    }
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Response Parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseQueryResponse(responseText: string): string {
  let text = responseText;
  if (text.startsWith(")]}'")) text = text.slice(4);

  const lines = text.trim().split("\n");
  let longestAnswer = "";
  let longestThinking = "";

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    if (/^\d+$/.test(line)) {
      i++;
      if (i < lines.length) {
        const [extracted, isAnswer] = extractAnswerFromChunk(lines[i]);
        if (extracted) {
          if (isAnswer && extracted.length > longestAnswer.length) {
            longestAnswer = extracted;
          } else if (!isAnswer && extracted.length > longestThinking.length) {
            longestThinking = extracted;
          }
        }
      }
      i++;
    } else {
      const [extracted, isAnswer] = extractAnswerFromChunk(line);
      if (extracted) {
        if (isAnswer && extracted.length > longestAnswer.length) {
          longestAnswer = extracted;
        } else if (!isAnswer && extracted.length > longestThinking.length) {
          longestThinking = extracted;
        }
      }
      i++;
    }
  }

  return longestAnswer || longestThinking;
}

function extractAnswerFromChunk(jsonStr: string): [string | null, boolean] {
  let data: unknown;
  try { data = JSON.parse(jsonStr); } catch { return [null, false]; }

  if (!Array.isArray(data) || data.length === 0) return [null, false];

  for (const item of data) {
    if (!Array.isArray(item) || item.length < 3) continue;
    if (item[0] !== "wrb.fr") continue;

    // Detect Error 16 in streaming response: ["wrb.fr", null, null, ..., [16]]
    if (item[1] === null && item[2] === null && Array.isArray(item[5]) && item[5].includes(16)) {
      throw new AuthError("Query Error 16: Authentication expired");
    }

    const innerJsonStr = item[2];
    if (typeof innerJsonStr !== "string") continue;

    let innerData: unknown;
    try { innerData = JSON.parse(innerJsonStr); } catch { continue; }

    if (!Array.isArray(innerData) || innerData.length === 0) continue;

    const firstElem = innerData[0];
    if (Array.isArray(firstElem) && firstElem.length > 0) {
      const answerText = firstElem[0];
      if (typeof answerText === "string" && answerText.length > 20) {
        // Check type indicator at firstElem[4][-1]: 1 = answer, 2 = thinking
        let isAnswer = false;
        if (firstElem.length > 4 && Array.isArray(firstElem[4])) {
          const typeInfo = firstElem[4] as unknown[];
          if (typeInfo.length > 0 && typeof typeInfo[typeInfo.length - 1] === "number") {
            isAnswer = typeInfo[typeInfo.length - 1] === 1;
          }
        }
        return [answerText, isAnswer];
      }
    } else if (typeof firstElem === "string" && firstElem.length > 20) {
      return [firstElem, false];
    }
  }

  return [null, false];
}
