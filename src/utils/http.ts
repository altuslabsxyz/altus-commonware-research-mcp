import type { IncomingMessage } from "node:http";

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Utilities
// ─────────────────────────────────────────────────────────────────────────────

export const htmlResponse = (title: string, message: string) =>
  `<html><body style="font-family:system-ui;padding:2rem;text-align:center"><h1>${title}</h1><p>${message}</p></body></html>`;

export const parseBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
