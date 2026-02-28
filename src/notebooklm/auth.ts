/**
 * Authentication token management for NotebookLM.
 *
 * Storage: ~/.altus-tutor-mcp/ with backward compat for ~/.notebooklm-mcp-cli/
 *
 * Ported from notebooklm-mcp-cli's core/auth.py + utils/config.py
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  extractCookiesViaCdp,
  findAvailablePort,
  type CdpExtractionResult,
} from "./chrome.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthTokens {
  cookies: Record<string, string>;
  csrfToken: string;
  sessionId: string;
  extractedAt: number;
}

// Required cookies for auth to work
const REQUIRED_COOKIES = ["SID", "HSID", "SSID", "APISID", "SAPISID"];

// ─────────────────────────────────────────────────────────────────────────────
// Storage Directories
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_DIR_NAME = ".altus-tutor-mcp";

export function getStorageDir(): string {
  const dir = join(homedir(), STORAGE_DIR_NAME);
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }
  return dir;
}

export function getChromeProfileDir(): string {
  const dir = join(getStorageDir(), "chrome-profile");
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700, recursive: true });
  }
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookie Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert CDP cookie list [{name, value, domain, ...}] to simple {name: value} dict.
 *
 * CDP's Network.getAllCookies returns cookies from ALL domains the browser has
 * visited. Auth cookies like HSID/SSID have different values on .youtube.com vs
 * .google.com — if we flatten blindly, last-write-wins can overwrite the correct
 * .google.com value. We filter to only Google-auth-relevant domains and process
 * them in priority order (parent → subdomain) to match what Python's httpx
 * cookie jar sends to notebooklm.google.com.
 */
export function parseCookiesFromChromeFormat(
  cookiesList: Array<Record<string, string>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  // 1. .google.com cookies first (parent domain)
  for (const cookie of cookiesList) {
    if (cookie.name && cookie.domain === ".google.com") {
      result[cookie.name] = cookie.value ?? "";
    }
  }
  // 2. notebooklm.google.com overrides parent with subdomain-specific values
  for (const cookie of cookiesList) {
    if (cookie.name && cookie.domain === "notebooklm.google.com") {
      result[cookie.name] = cookie.value ?? "";
    }
  }
  // 3. accounts.google.com cookies that don't collide (e.g. LSID, __Host-GAPS)
  for (const cookie of cookiesList) {
    if (cookie.name && cookie.domain === "accounts.google.com" && !(cookie.name in result)) {
      result[cookie.name] = cookie.value ?? "";
    }
  }
  return result;
}

export function validateCookies(cookies: Record<string, string>): boolean {
  return REQUIRED_COOKIES.every((name) => name in cookies);
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Persistence
// ─────────────────────────────────────────────────────────────────────────────

function authJsonPath(): string {
  return join(getStorageDir(), "auth.json");
}

export function saveTokens(tokens: AuthTokens): void {
  const filePath = authJsonPath();
  writeFileSync(filePath, JSON.stringify(tokens, null, 2), "utf-8");
  try { chmodSync(filePath, 0o600); } catch { /* best effort */ }
}

export function loadCachedTokens(): AuthTokens | null {
  // 1. Try our own auth.json
  const ourPath = authJsonPath();
  const loaded = tryLoadAuthJson(ourPath);
  if (loaded) return loaded;

  // 2. Backward compat: try ~/.notebooklm-mcp-cli/auth.json
  const legacyPath = join(homedir(), ".notebooklm-mcp-cli", "auth.json");
  const legacy = tryLoadAuthJson(legacyPath);
  if (legacy) return legacy;

  // 3. Backward compat: try ~/.notebooklm-mcp-cli/profiles/default/cookies.json
  const profileCookiesPath = join(homedir(), ".notebooklm-mcp-cli", "profiles", "default", "cookies.json");
  if (existsSync(profileCookiesPath)) {
    try {
      const raw = JSON.parse(readFileSync(profileCookiesPath, "utf-8"));
      let cookies: Record<string, string>;
      if (Array.isArray(raw)) {
        // CDP format [{name, value, ...}]
        cookies = parseCookiesFromChromeFormat(raw);
      } else {
        cookies = raw as Record<string, string>;
      }
      if (validateCookies(cookies)) {
        // Also try to load metadata for CSRF/session
        let csrfToken = "";
        let sessionId = "";
        const metaPath = join(homedir(), ".notebooklm-mcp-cli", "profiles", "default", "metadata.json");
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
            csrfToken = meta.csrf_token ?? "";
            sessionId = meta.session_id ?? "";
          } catch { /* ignore */ }
        }
        return { cookies, csrfToken, sessionId, extractedAt: Date.now() / 1000 };
      }
    } catch { /* ignore */ }
  }

  return null;
}

function tryLoadAuthJson(filePath: string): AuthTokens | null {
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    // Support both our format and the Python format
    const cookies = data.cookies as Record<string, string> | undefined;
    if (!cookies || !validateCookies(cookies)) return null;
    return {
      cookies,
      csrfToken: data.csrfToken ?? data.csrf_token ?? "",
      sessionId: data.sessionId ?? data.session_id ?? "",
      extractedAt: data.extractedAt ?? data.extracted_at ?? 0,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Login Flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Full interactive login flow via Chrome CDP.
 * Launches Chrome, waits for user to log in, extracts cookies.
 */
export async function login(): Promise<AuthTokens> {
  const port = await findAvailablePort();
  const profileDir = getChromeProfileDir();

  const result: CdpExtractionResult = await extractCookiesViaCdp({
    port,
    autoLaunch: true,
    waitForLogin: true,
    loginTimeout: 300,
    profileDir,
  });

  // Convert CDP cookies to simple dict
  const cookies = parseCookiesFromChromeFormat(result.cookies);

  if (!validateCookies(cookies)) {
    throw new Error(
      "Extracted cookies are missing required auth cookies (SID, HSID, etc.). " +
      "Make sure you fully completed the Google sign-in.",
    );
  }

  const tokens: AuthTokens = {
    cookies,
    csrfToken: result.csrfToken,
    sessionId: result.sessionId,
    extractedAt: Date.now() / 1000,
  };

  saveTokens(tokens);
  return tokens;
}
