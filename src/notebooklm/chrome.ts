/**
 * Chrome DevTools Protocol (CDP) utilities for cookie extraction.
 *
 * Provides a keychain-free way to extract cookies from Chrome via CDP:
 *   1. Chrome is launched with --remote-debugging-port
 *   2. We connect via WebSocket and use Network.getAllCookies
 *   3. No keychain access required
 *
 * Ported from notebooklm-mcp-cli's utils/cdp.py
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import WebSocket from "ws";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const CDP_PORT_RANGE_START = 9222;
const CDP_PORT_RANGE_END = 9232;

// ─────────────────────────────────────────────────────────────────────────────
// WSL2 Detection
// ─────────────────────────────────────────────────────────────────────────────

function isWsl(): boolean {
  return os.release().toLowerCase().includes("microsoft");
}

// ─────────────────────────────────────────────────────────────────────────────
// Find Chrome Executable
// ─────────────────────────────────────────────────────────────────────────────

export function findChrome(): string | null {
  const platform = os.platform();

  if (platform === "darwin") {
    const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    return existsSync(macPath) ? macPath : null;
  }

  // Linux (including WSL2)
  if (platform === "linux") {
    // Native Linux Chrome candidates
    const linuxCandidates = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ];
    for (const candidate of linuxCandidates) {
      try {
        const resolved = execSync(`which ${candidate}`, { encoding: "utf-8" }).trim();
        if (resolved) return resolved;
      } catch { /* not found */ }
    }

    // WSL2: try Windows Chrome/Edge paths
    if (isWsl()) {
      const wslCandidates = [
        "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
        "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      ];
      for (const candidate of wslCandidates) {
        if (existsSync(candidate)) return candidate;
      }
    }

    return null;
  }

  // Windows (non-WSL)
  if (platform === "win32") {
    const winPath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    return existsSync(winPath) ? winPath : null;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Port Utilities
// ─────────────────────────────────────────────────────────────────────────────

export function findAvailablePort(startingFrom = 9222, maxAttempts = 10): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryPort(port: number): void {
      const server = createServer();
      server.once("error", () => {
        attempt++;
        if (attempt >= maxAttempts) {
          reject(new Error(
            `No available ports in range ${startingFrom}-${startingFrom + maxAttempts - 1}. ` +
            "Close some applications and try again.",
          ));
        } else {
          tryPort(port + 1);
        }
      });
      server.once("listening", () => {
        server.close(() => resolve(port));
      });
      server.listen(port, "localhost");
    }

    tryPort(startingFrom);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Chrome Process Management
// ─────────────────────────────────────────────────────────────────────────────

export function launchChrome(
  port: number,
  profileDir: string,
): ChildProcess {
  const chromePath = findChrome();
  if (!chromePath) {
    throw new Error("Chrome not found. Install Google Chrome to use the login flow.");
  }

  const args = [
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    `--user-data-dir=${profileDir}`,
    "--remote-allow-origins=*",
  ];

  const proc = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "ignore"],
    detached: false,
  });

  return proc;
}

export function terminateChrome(proc: ChildProcess): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CDP HTTP Endpoints
// ─────────────────────────────────────────────────────────────────────────────

export async function getDebuggerUrl(port: number): Promise<string | null> {
  try {
    const resp = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json() as Record<string, string>;
    return data.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

export async function getPages(port: number): Promise<Array<Record<string, string>>> {
  try {
    const resp = await fetch(`http://localhost:${port}/json`, {
      signal: AbortSignal.timeout(5000),
    });
    return await resp.json() as Array<Record<string, string>>;
  } catch {
    return [];
  }
}

export async function findExistingChromeDebugger(): Promise<number | null> {
  for (let port = CDP_PORT_RANGE_START; port < CDP_PORT_RANGE_END; port++) {
    try {
      const resp = await fetch(`http://localhost:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return port;
    } catch { /* not listening */ }
  }
  return null;
}

export async function findOrCreateNotebookLmPage(
  port: number,
): Promise<Record<string, string> | null> {
  const pages = await getPages(port);

  // Look for existing NotebookLM page
  for (const page of pages) {
    if (page.url?.includes("notebooklm.google.com")) {
      return page;
    }
  }

  // Create a new page
  try {
    const encodedUrl = encodeURIComponent(NOTEBOOKLM_URL);
    const resp = await fetch(`http://localhost:${port}/json/new?${encodedUrl}`, {
      method: "PUT",
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const text = await resp.text();
      if (text.trim()) return JSON.parse(text) as Record<string, string>;
    }

    // Fallback: create blank page then navigate
    const resp2 = await fetch(`http://localhost:${port}/json/new`, {
      method: "PUT",
      signal: AbortSignal.timeout(10000),
    });
    if (resp2.ok) {
      const text2 = await resp2.text();
      if (text2.trim()) {
        const page = JSON.parse(text2) as Record<string, string>;
        if (page.webSocketDebuggerUrl) {
          await navigateToUrl(page.webSocketDebuggerUrl, NOTEBOOKLM_URL);
        }
        return page;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CDP WebSocket Commands
// ─────────────────────────────────────────────────────────────────────────────

export function executeCdpCommand(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { origin: undefined });
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP command timed out: ${method}`));
    }, 30000);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });

    ws.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString()) as { id?: number; result?: Record<string, unknown> };
        if (response.id === 1) {
          clearTimeout(timeout);
          ws.close();
          resolve(response.result ?? {});
        }
      } catch { /* wait for correct message */ }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export async function getPageCookies(wsUrl: string): Promise<Array<Record<string, string>>> {
  const result = await executeCdpCommand(wsUrl, "Network.getAllCookies");
  return (result.cookies ?? []) as Array<Record<string, string>>;
}

export async function getPageHtml(wsUrl: string): Promise<string> {
  await executeCdpCommand(wsUrl, "Runtime.enable");
  const result = await executeCdpCommand(wsUrl, "Runtime.evaluate", {
    expression: "document.documentElement.outerHTML",
  });
  const inner = result.result as Record<string, string> | undefined;
  return inner?.value ?? "";
}

export async function getCurrentUrl(wsUrl: string): Promise<string> {
  await executeCdpCommand(wsUrl, "Runtime.enable");
  const result = await executeCdpCommand(wsUrl, "Runtime.evaluate", {
    expression: "window.location.href",
  });
  const inner = result.result as Record<string, string> | undefined;
  return inner?.value ?? "";
}

export async function navigateToUrl(wsUrl: string, url: string): Promise<void> {
  await executeCdpCommand(wsUrl, "Page.enable");
  await executeCdpCommand(wsUrl, "Page.navigate", { url });
  // Wait for page to load
  await new Promise((r) => setTimeout(r, 3000));
}

// ─────────────────────────────────────────────────────────────────────────────
// Login Detection & Token Extraction
// ─────────────────────────────────────────────────────────────────────────────

export function isLoggedIn(url: string): boolean {
  if (url.includes("accounts.google.com")) return false;
  if (url.includes("notebooklm.google.com")) return true;
  return false;
}

export function extractCsrfToken(html: string): string {
  const match = html.match(/"SNlM0e":"([^"]+)"/);
  return match ? match[1] : "";
}

export function extractSessionId(html: string): string {
  const patterns = [
    /"FdrFJe":"(\d+)"/,
    /f\.sid["\s:=]+["']?(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Full CDP Cookie Extraction Flow
// ─────────────────────────────────────────────────────────────────────────────

export interface CdpExtractionResult {
  cookies: Array<Record<string, string>>;
  csrfToken: string;
  sessionId: string;
}

/**
 * Extract cookies and tokens from Chrome via CDP.
 * Exact port of Python's `extract_cookies_via_cdp()`.
 */
export async function extractCookiesViaCdp(options: {
  port: number;
  autoLaunch?: boolean;
  waitForLogin?: boolean;
  loginTimeout?: number;
  profileDir: string;
}): Promise<CdpExtractionResult> {
  const {
    autoLaunch = true,
    waitForLogin = true,
    loginTimeout = 300,
    profileDir,
  } = options;
  let { port } = options;

  let chromeProc: ChildProcess | null = null;

  try {
    // Check for existing Chrome instance on any port in range
    const existingPort = await findExistingChromeDebugger();
    let debuggerUrl: string | null = null;

    if (existingPort) {
      port = existingPort;
      debuggerUrl = await getDebuggerUrl(port);
    }

    if (!debuggerUrl && autoLaunch) {
      if (!findChrome()) {
        throw new Error(
          "Chrome not found. Install Google Chrome to use the login flow.",
        );
      }

      port = await findAvailablePort();
      chromeProc = launchChrome(port, profileDir);

      // Wait for Chrome to start
      await new Promise((r) => setTimeout(r, 3000));

      debuggerUrl = await getDebuggerUrl(port);
    }

    if (!debuggerUrl) {
      throw new Error(`Cannot connect to Chrome on port ${port}.`);
    }

    // Find or create NotebookLM page
    const page = await findOrCreateNotebookLmPage(port);
    if (!page) {
      throw new Error("Failed to open NotebookLM page.");
    }

    const wsUrl = page.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new Error("No WebSocket URL for page. Chrome may need to be restarted.");
    }

    // Navigate to NotebookLM if needed
    if (!page.url?.includes("notebooklm.google.com")) {
      await navigateToUrl(wsUrl, NOTEBOOKLM_URL);
    }

    // Check login status
    let currentUrl = await getCurrentUrl(wsUrl);

    if (!isLoggedIn(currentUrl) && waitForLogin) {
      // Wait for login - poll every 5 seconds
      const startTime = Date.now();
      while ((Date.now() - startTime) / 1000 < loginTimeout) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          currentUrl = await getCurrentUrl(wsUrl);
          if (isLoggedIn(currentUrl)) break;
        } catch { /* retry */ }
      }

      if (!isLoggedIn(currentUrl)) {
        throw new Error("Login timeout. Please log in to NotebookLM in the Chrome window.");
      }
    }

    // Extract cookies
    const cookies = await getPageCookies(wsUrl);
    if (cookies.length === 0) {
      throw new Error("No cookies extracted. Make sure you're fully logged in.");
    }

    // Get page HTML for CSRF and session ID
    const html = await getPageHtml(wsUrl);
    const csrfToken = extractCsrfToken(html);
    const sessionId = extractSessionId(html);

    return { cookies, csrfToken, sessionId };
  } finally {
    if (chromeProc) {
      terminateChrome(chromeProc);
    }
  }
}
