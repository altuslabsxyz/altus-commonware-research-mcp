import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Session Security Module
// ─────────────────────────────────────────────────────────────────────────────
// This module provides security primitives to protect sessions when the MCP
// server is shared among multiple teammates.

const SESSION_SECRET_BYTES = 32;
const HMAC_ALGORITHM = "sha256";

// Store session secrets (separate from session data for security isolation)
const sessionSecrets = new Map<string, string>();

// ─────────────────────────────────────────────────────────────────────────────
// Session Secret Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure session secret.
 * This secret must be stored by the client and provided on every request.
 */
export function generateSessionSecret(): string {
  return randomBytes(SESSION_SECRET_BYTES).toString("base64url");
}

/**
 * Store a session secret for a given session ID.
 */
export function setSessionSecret(sessionId: string, secret: string): void {
  sessionSecrets.set(sessionId, secret);
}

/**
 * Validate a session secret using timing-safe comparison.
 * Returns true if the secret matches, false otherwise.
 */
export function validateSessionSecret(sessionId: string, providedSecret: string | undefined): boolean {
  const storedSecret = sessionSecrets.get(sessionId);

  if (!storedSecret || !providedSecret) {
    return false;
  }

  try {
    const storedBuffer = Buffer.from(storedSecret, "base64url");
    const providedBuffer = Buffer.from(providedSecret, "base64url");

    if (storedBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(storedBuffer, providedBuffer);
  } catch {
    return false;
  }
}

/**
 * Clear a session secret when the session ends.
 */
export function clearSessionSecret(sessionId: string): void {
  sessionSecrets.delete(sessionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Protected OAuth State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a protected OAuth state that binds to a specific MCP session.
 * The state includes an HMAC signature to prevent tampering.
 */
export function createProtectedState(mcpSessionId: string): string {
  const nonce = randomBytes(16).toString("hex");
  const secret = sessionSecrets.get(mcpSessionId);

  if (!secret) {
    // Fallback if no secret (shouldn't happen in normal flow)
    return nonce;
  }

  // Create HMAC of sessionId + nonce using the session secret
  const hmac = createHmac(HMAC_ALGORITHM, secret)
    .update(`${mcpSessionId}:${nonce}`)
    .digest("hex");

  // Format: nonce.hmac (we can extract nonce for verification)
  return `${nonce}.${hmac.slice(0, 16)}`;
}

/**
 * Validate a protected OAuth state for a given session.
 * Verifies the HMAC signature matches the expected value.
 */
export function validateProtectedState(state: string, mcpSessionId: string): boolean {
  const secret = sessionSecrets.get(mcpSessionId);

  if (!secret) {
    return false;
  }

  const parts = state.split(".");
  if (parts.length !== 2) {
    return false;
  }

  const [nonce, providedHmac] = parts;

  // Recreate the expected HMAC
  const expectedHmac = createHmac(HMAC_ALGORITHM, secret)
    .update(`${mcpSessionId}:${nonce}`)
    .digest("hex")
    .slice(0, 16);

  try {
    const providedBuffer = Buffer.from(providedHmac, "hex");
    const expectedBuffer = Buffer.from(expectedHmac, "hex");

    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}
