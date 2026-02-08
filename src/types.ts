// ─────────────────────────────────────────────────────────────────────────────
// OAuth & Session Types
// ─────────────────────────────────────────────────────────────────────────────
export type Session = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
};

export type OAuthPending = {
  verifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  createdAt: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Notion Types
// ─────────────────────────────────────────────────────────────────────────────
export type PageInfo = {
  id: string;
  title: string;
  content?: string;
  children?: PageInfo[];
};

export type ScoredParagraph = {
  text: string;
  score: number;
  pageId: string;
  pageTitle: string;
};
