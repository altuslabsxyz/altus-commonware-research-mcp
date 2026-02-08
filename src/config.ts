import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// ─────────────────────────────────────────────────────────────────────────────
// Environment Setup
// ─────────────────────────────────────────────────────────────────────────────
const FILE_DIR = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(FILE_DIR, "..", ".env") });

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────
export const NOTION_BASE = (process.env.NOTION_MCP_URL ?? "https://mcp.notion.com").replace(/\/(mcp|sse)$/, "");

// Cloud Run provides PORT, default to 3100 for local
export const MCP_PORT = parseInt(process.env.PORT ?? "3100", 10);

// For Cloud Run, we need the public URL
export const OAUTH_CALLBACK_URL = process.env.OAUTH_CALLBACK_URL ?? `http://localhost:${MCP_PORT}/callback`;

export const ROOT_PAGE_IDS = (process.env.NOTION_PAGE_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
export const OAUTH_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

