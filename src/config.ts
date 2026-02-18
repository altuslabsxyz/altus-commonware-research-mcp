import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// ─────────────────────────────────────────────────────────────────────────────
// Environment Setup
// ─────────────────────────────────────────────────────────────────────────────
const FILE_DIR = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(FILE_DIR, "..", ".env") });

// ─────────────────────────────────────────────────────────────────────────────
// NotebookLM Configuration
// ─────────────────────────────────────────────────────────────────────────────
export const NOTEBOOK_ID = process.env.NOTEBOOK_ID ?? "";

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Configuration
// ─────────────────────────────────────────────────────────────────────────────
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

export const REFERENCE_REPOS: readonly string[] = (
  process.env.REFERENCE_REPOS ?? ""
).split(",").map(r => r.trim()).filter(Boolean);
